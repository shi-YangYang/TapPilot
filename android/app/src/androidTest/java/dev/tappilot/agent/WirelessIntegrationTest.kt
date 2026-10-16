package dev.tappilot.agent

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Real Android TLS/WSS stack and Node hub, synthetic executor only: never reads or touches real UI. */
@RunWith(AndroidJUnit4::class)
class WirelessIntegrationTest {
    @Test fun connectsToDesktopHub() {
        val uri = InstrumentationRegistry.getArguments().getString("pairingUri")
        assumeNotNull(uri)
        val pairing = PairingInfo.parse(uri!!)
        val ready = CountDownLatch(1); val disconnected = CountDownLatch(1)
        val calls = AtomicInteger(); val actions = AtomicInteger()
        val session = "48fc031b-e086-4db2-91df-637f97f4f74a"
        fun tree(): JSONObject {
            val revision = if (actions.get() == 0) 1 else 2
            val node = JSONObject().put("nodeId", "n0").put("parentId", JSONObject.NULL)
                .put("text", if (revision == 1) "无线测试入口" else "无线测试结果").put("contentDescription", "")
                .put("resourceId", "fixture:id/entry").put("className", "android.widget.Button")
                .put("bounds", JSONArray(listOf(0, 0, 100, 100))).put("clickable", true).put("scrollable", false)
                .put("editable", false).put("enabled", true).put("password", false).put("visible", true)
            return JSONObject().put("snapshotId", "$session:$revision").put("revision", revision).put("windowId", 7)
                .put("packageName", "dev.tappilot.fixture").put("nodes", JSONArray().put(node)).put("truncated", false)
        }
        WirelessConnection(pairing, "tappilot-instrumentation-fixture", "Android synthetic fixture", PhoneExecutor { name, args, canContinue ->
            assertTrue("fixture session was cancelled", canContinue())
            when (name) {
                "get_ui_tree" -> { val number = calls.incrementAndGet(); assertTrue("unexpected read order", number == 1 || number == 3); tree() }
                "act_and_observe" -> {
                    assertEquals(2, calls.incrementAndGet()); assertEquals("click_element", args.getString("action"))
                    assertEquals("$session:1", args.getJSONObject("arguments").getString("snapshotId"))
                    assertEquals("n0", args.getJSONObject("arguments").getString("nodeId"))
                    assertEquals(1, actions.incrementAndGet())
                    JSONObject().put("action", JSONObject().put("accepted", true).put("revision", 2).put("action", "click").put("verificationRequired", true))
                        .put("observation", tree()).put("timings", JSONObject().put("actionMs", 0).put("waitMs", 0).put("observationMs", 0).put("totalMs", 0))
                }
                else -> throw AgentError("UNKNOWN_METHOD", "Fixture supports only read/action/read")
            }
        }, {}) { connected, _ -> if (connected) ready.countDown() else disconnected.countDown() }.use { connection ->
            connection.start()
            assertTrue("desktop fixture did not connect", ready.await(15, TimeUnit.SECONDS))
            assertTrue("desktop fixture did not disconnect", disconnected.await(25, TimeUnit.SECONDS))
            assertEquals("fixture command count", 3, calls.get())
            assertEquals("fixture action count", 1, actions.get())
        }
    }
}
