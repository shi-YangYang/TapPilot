package dev.tappilot.agent

import java.security.MessageDigest

/** Fixed diagnostics only: never include node IDs, text, paths or other UI data. */
internal enum class SnapshotStaleReason {
    SNAPSHOT_MISSING, WINDOW_CHANGED, TREE_INCOMPLETE, TREE_STRUCTURE_CHANGED,
    NODE_CONTENT_CHANGED, NODE_BOUNDS_CHANGED, NODE_STATE_CHANGED, NODE_UNAVAILABLE;
}

internal fun staleSnapshot(reason: SnapshotStaleReason): AgentError = AgentError(
    "STALE_SNAPSHOT", "The UI changed or the snapshot expired. Read the UI again before acting.", true, reason.name,
)

/** The same full-field SHA-256 fingerprint as before, without a Formatter per byte. */
internal fun snapshotFingerprintDigest(fields: List<Any?>): String {
    val bytes = MessageDigest.getInstance("SHA-256").digest(fields.joinToString("\u0000").toByteArray(Charsets.UTF_8))
    val alphabet = "0123456789abcdef"
    val chars = CharArray(bytes.size * 2)
    for (index in bytes.indices) {
        val value = bytes[index].toInt() and 0xff
        chars[index * 2] = alphabet[value ushr 4]
        chars[index * 2 + 1] = alphabet[value and 0x0f]
    }
    return String(chars)
}

internal data class SnapshotNodeFingerprint(
    val digest: String,
    val bounds: List<Int>,
    val stateBits: Int,
    val childCount: Int,
) {
    fun changeFrom(previous: SnapshotNodeFingerprint): SnapshotStaleReason? {
        if (bounds != previous.bounds) return SnapshotStaleReason.NODE_BOUNDS_CHANGED
        if (childCount != previous.childCount) return SnapshotStaleReason.TREE_STRUCTURE_CHANGED
        if (stateBits != previous.stateBits) return SnapshotStaleReason.NODE_STATE_CHANGED
        if (digest != previous.digest) return SnapshotStaleReason.NODE_CONTENT_CHANGED
        return null
    }
}

internal data class SnapshotNodeState(val path: List<Int>, val fingerprint: SnapshotNodeFingerprint)

/** Consumes a bounded live DFS without creating another JSON tree or retaining live nodes. */
internal class StreamingSnapshotValidator(private val expected: List<SnapshotNodeState>, complete: Boolean) {
    var count = 0
        private set

    init { if (!complete) incomplete() }

    fun accept(path: List<Int>, fingerprint: SnapshotNodeFingerprint) {
        val previous = expected.getOrNull(count) ?: throw staleSnapshot(SnapshotStaleReason.TREE_STRUCTURE_CHANGED)
        if (path != previous.path) throw staleSnapshot(SnapshotStaleReason.TREE_STRUCTURE_CHANGED)
        fingerprint.changeFrom(previous.fingerprint)?.let { throw staleSnapshot(it) }
        count++
    }

    fun finish() {
        if (count != expected.size) throw staleSnapshot(SnapshotStaleReason.TREE_STRUCTURE_CHANGED)
    }

    fun incomplete(): Nothing = throw staleSnapshot(SnapshotStaleReason.TREE_INCOMPLETE)
}

/** One read-only recovery for unavailable children, never a retry loop around an action.
 * Capacity/depth truncation is not a transient-cache signal and must not enter this path.
 */
internal fun <T> captureWithMissingChildRecovery(read: (refreshCache: Boolean) -> T, missingChild: (T) -> Boolean): T {
    val first = read(false)
    return if (missingChild(first)) read(true) else first
}
