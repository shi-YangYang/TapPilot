package dev.tappilot.agent

import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest
import java.security.cert.CertificateException

class PairingTest {
    private val good = "tappilot://pair?host=192.168.1.8&port=4567&fingerprint=${"a".repeat(64)}&token=${"b".repeat(43)}"
    @Test fun acceptsOnlyStrictPrivatePairingUris() {
        val pair = PairingInfo.parse(good)
        assertEquals("wss://192.168.1.8:4567/phone", pair.socketUrl)
        assertFalse(pair.toString().contains("b".repeat(43)))
        for (bad in listOf(good + "&token=duplicate", good + "&extra=1", good.replace("192.168.1.8", "8.8.8.8"),
            good.replace("192.168.1.8", "127.0.0.1"), good.replace("192.168.1.8", "192.168.01.8"), good.replace("4567", "0"), good + "#fragment", good.replace("//pair?", "//pair/path?"))) {
            try { PairingInfo.parse(bad); fail("invalid URI accepted") } catch (error: AgentError) { assertEquals("INVALID_PAIRING", error.code) }
        }
    }
    @Test fun pinMustMatchAndCertificateMustBeValid() {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build().certificate
        val pin = MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02x".format(it) }
        PairedTrustManager(pin).checkServerTrusted(arrayOf(certificate), "RSA")
        try { PairedTrustManager("0".repeat(64)).checkServerTrusted(arrayOf(certificate), "RSA"); fail("bad pin accepted") } catch (_: CertificateException) {}
        val expired = HeldCertificate.Builder().validityInterval(System.currentTimeMillis() - 120000, System.currentTimeMillis() - 60000).build().certificate
        val expiredPin = MessageDigest.getInstance("SHA-256").digest(expired.encoded).joinToString("") { "%02x".format(it) }
        try { PairedTrustManager(expiredPin).checkServerTrusted(arrayOf(expired), "RSA"); fail("expired certificate accepted") } catch (_: CertificateException) {}
    }
    @Test fun automationOwnerCannotBeStolenOrReleasedByAnotherSession() {
        val first = Any(); val second = Any()
        try {
            assertTrue(AutomationOwner.acquire(first))
            assertFalse(AutomationOwner.acquire(second))
            AutomationOwner.release(second)
            assertTrue(AutomationOwner.busy())
        } finally { AutomationOwner.release(first) }
        assertFalse(AutomationOwner.busy())
    }
}
