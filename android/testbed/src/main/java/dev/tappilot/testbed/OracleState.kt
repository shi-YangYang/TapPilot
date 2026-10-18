package dev.tappilot.testbed

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File

/** Business state comes from handlers, never from accessibility labels or the agent's answer. */
object OracleState {
    val scenes = setOf("navigation", "search", "async_list", "ime", "overlay", "long_list", "webview", "canvas") + NativeExecutorScenes.names + SemanticObservationScenes.names + ReliabilityScenes.names + StartupReadinessScenes.names + ActionReadinessScenes.names + LateTransitionReadinessScenes.names + DeclaredLabelReadinessScenes.names + NativeTabRefreshScenes.names + InputSettlingScenes.names + VisualActionScenes.names + RawSwipeWindowScenes.names + DynamicNavigationScenes.names
    private var state = JSONObject()
    private var directory: File? = null

    @Synchronized fun reset(context: Context, scene: String, seed: Int, runId: String) {
        require(scene in scenes)
        directory = context.filesDir
        state = JSONObject().put("schemaVersion", 1).put("scene", scene).put("seed", seed).put("runId", runId)
            .put("variantId", "legacy").put("configurationError", false)
            .put("page", "initial").put("lastTarget", "none").put("receivedInput", "none")
            .put("inputField", "none").put("focus", "none").put("recipient", "synthetic_a")
            .put("wrongClicks", 0).put("clickCount", 0).put("revision", 0).put("refreshCount", 0)
            .put("orderChangeCount", 0).put("replacementCount", 0).put("peerTextChangeCount", 0)
            .put("armed", false).put("changed", false)
            .put("overlayDismissed", false).put("completed", false)
        persist()
    }

    @Synchronized fun update(vararg fields: Pair<String, Any>) {
        for ((key, value) in fields) state.put(key, value)
        state.put("revision", state.optInt("revision") + 1)
        persist()
    }

    @Synchronized fun click(target: String, correct: Boolean = true) {
        state.put("lastTarget", target)
        state.put("clickCount", state.optInt("clickCount") + 1)
        if (!correct) state.put("wrongClicks", state.optInt("wrongClicks") + 1)
        state.put("revision", state.optInt("revision") + 1)
        persist()
    }

    /** Never save arbitrary user input, even in this synthetic app. */
    fun input(field: String, value: String, expected: String) = update(
        "inputField" to field,
        "receivedInput" to when (value) { "" -> "empty"; expected -> "expected"; else -> "other" }
    )

    @Synchronized fun snapshot(context: Context): JSONObject {
        // Reads are also valid if Android restarted the process after a task.
        return try { JSONObject(AtomicFile(File(context.filesDir, "oracle.json")).openRead().bufferedReader().use { it.readText() }) }
        catch (_: Exception) { JSONObject().put("schemaVersion", 1).put("initialized", false) }
    }

    private fun persist() {
        val file = AtomicFile(File(requireNotNull(directory), "oracle.json"))
        val stream = file.startWrite()
        try { stream.write(state.toString().toByteArray(Charsets.UTF_8)); file.finishWrite(stream) }
        catch (error: Exception) { file.failWrite(stream); throw error }
    }
}

/** Same-UID only, read-only. The host harness can read the app-private JSON using debug run-as. */
class OracleProvider : ContentProvider() {
    override fun onCreate() = true
    override fun getType(uri: Uri) = "application/json"
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        require(uri.path == "/state")
        return MatrixCursor(arrayOf("json")).apply { addRow(arrayOf(OracleState.snapshot(requireNotNull(context)).toString())) }
    }
    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException("read only")
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException("read only")
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException("read only")
}
