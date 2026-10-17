package dev.tappilot.agent

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Build
import android.os.Process
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue

/** Uses the production server with real Android sockets; never changes the shell/root UID gate. */
@RunWith(AndroidJUnit4::class)
class RpcServerLifecycleInstrumentedTest {
    private fun awaitBlockedAccept(threadName: String) {
        val deadline = SystemClock.uptimeMillis() + 3_000
        do {
            // Do not merely sleep and assume start() has reached the native blocking call.
            if (Thread.getAllStackTraces().any { (thread, frames) ->
                thread.name == threadName && thread.isAlive && frames.any { it.methodName == "accept" }
            }) return
            SystemClock.sleep(15)
        } while (SystemClock.uptimeMillis() < deadline)
        fail("production accept thread did not reach blocking accept")
    }

    @Test fun blockedAcceptCanCloseAndImmediatelyRebindWithoutAdmittingSameUidClients() {
        assumeTrue("isolated emulator only", Build.HARDWARE in setOf("ranchu", "goldfish"))
        assertTrue("same-UID test must run as an ordinary app", Process.myUid() !in setOf(0, 2000))
        val name = "tappilot-rpc-test-${UUID.randomUUID()}"
        val threadName = "$name-accept"
        val failures = ConcurrentLinkedQueue<String>()
        // Same-UID peers are rejected before dispatch, so no attached service, real UI, or
        // permission changes are needed to exercise the actual production accept lifecycle.
        val service = AgentAccessibilityService()
        repeat(3) {
            val server = RpcServer(service, socketName = name, onFailure = { _, code -> failures.add(code) })
            try {
                server.start()
                awaitBlockedAccept(threadName)
                LocalSocket().use { client ->
                    client.connect(LocalSocketAddress(name, LocalSocketAddress.Namespace.ABSTRACT))
                    client.soTimeout = 1_000
                    assertEquals("ordinary app UID must be rejected, not served", -1, client.inputStream.read())
                }
                awaitBlockedAccept(threadName)
            } finally { server.close() }
            assertFalse("old accept thread survived close", Thread.getAllStackTraces().keys.any {
                it.name == threadName && it.isAlive
            })
            server.close() // Closing twice must not affect the next server's file descriptor.
            assertTrue("unexpected RPC lifecycle failure: $failures", failures.isEmpty())
            // An immediate real bind is the assertion: delayed GC or a later connect must not
            // be needed to release the abstract namespace held by the old blocked accept.
            LocalServerSocket(name).use { }
        }
    }
}
