package dev.tappilot.agent

import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

internal data class PairingInfo(val host: String, val port: Int, val fingerprint: String, val token: String) {
    val socketUrl: String get() = "wss://$host:$port/phone"
    // Never use the data class default (which would print the pairing token).
    override fun toString() = "PairingInfo(host=$host, port=$port, credentials=[REDACTED])"
    companion object {
        fun parse(value: String): PairingInfo {
            fun invalid(): Nothing = throw AgentError("INVALID_PAIRING", "配对地址无效，请重新扫描电脑端二维码或完整粘贴配对地址")
            if (value.length > 2048) invalid()
            val uri = try { URI(value.trim()) } catch (_: Exception) { invalid() }
            if (uri.scheme != "tappilot" || uri.host != "pair" || uri.rawUserInfo != null || uri.port != -1 || !uri.rawPath.isNullOrEmpty() || uri.rawFragment != null) invalid()
            val pairs = mutableMapOf<String, String>()
            for (part in uri.rawQuery?.split('&') ?: invalid()) {
                val split = part.split('=', limit = 2)
                if (split.size != 2) invalid()
                val name = try { URLDecoder.decode(split[0], "UTF-8") } catch (_: Exception) { invalid() }
                val text = try { URLDecoder.decode(split[1], "UTF-8") } catch (_: Exception) { invalid() }
                if (pairs.put(name, text) != null) invalid()
            }
            if (pairs.keys != setOf("host", "port", "fingerprint", "token")) invalid()
            val host = pairs.getValue("host")
            if (!privateIpv4(host)) invalid()
            val port = pairs.getValue("port").takeIf { it.matches(Regex("[1-9][0-9]{0,4}")) }?.toIntOrNull() ?: invalid()
            if (port !in 1..65535) invalid()
            val pin = pairs.getValue("fingerprint")
            val token = pairs.getValue("token")
            if (!pin.matches(Regex("[a-fA-F0-9]{64}")) || !token.matches(Regex("[A-Za-z0-9_-]{43}"))) invalid()
            return PairingInfo(host, port, pin.lowercase(), token)
        }
        private fun privateIpv4(host: String): Boolean {
            val parts = host.split('.')
            if (parts.size != 4 || parts.any { !it.matches(Regex("0|[1-9][0-9]{0,2}")) }) return false
            val nums = parts.map { it.toIntOrNull() ?: return false }
            if (nums.any { it !in 0..255 }) return false
            return nums[0] == 10 || (nums[0] == 172 && nums[1] in 16..31) || (nums[0] == 192 && nums[1] == 168)
        }
    }
}

/** A self-signed LAN certificate is trusted only if its exact DER fingerprint was paired locally. */
internal class PairedTrustManager(private val fingerprint: String) : X509TrustManager {
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("Missing pinned certificate")
        if (authType.isNullOrBlank()) throw CertificateException("Missing authentication type")
        leaf.checkValidity()
        val actual = MessageDigest.getInstance("SHA-256").digest(leaf.encoded)
        val expected = try { fingerprint.chunked(2).map { it.toInt(16).toByte() }.toByteArray() } catch (_: Exception) { throw CertificateException("Invalid certificate pin") }
        if (expected.size != 32 || !MessageDigest.isEqual(expected, actual)) throw CertificateException("Certificate pin mismatch")
    }
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) { throw CertificateException("Client certificates are not supported") }
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    fun context(): SSLContext = SSLContext.getInstance("TLS").apply { init(null, arrayOf(this@PairedTrustManager), null) }
}
