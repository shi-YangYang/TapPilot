package dev.tappilot.agent

import java.math.BigInteger
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SnapshotValidationTest {
    private val original = SnapshotNodeFingerprint("synthetic-digest", listOf(0, 0, 100, 100), 3, 0)
    private val root = SnapshotNodeState(emptyList(), original.copy(childCount = 2))
    private val first = SnapshotNodeState(listOf(0), original)
    private val second = SnapshotNodeState(listOf(1), original.copy(digest = "second-synthetic-digest"))
    private fun validator() = StreamingSnapshotValidator(listOf(root, first, second), complete = true)
    private fun failure(reason: SnapshotStaleReason, block: () -> Unit) {
        try { block(); fail("Expected a stale snapshot") }
        catch (error: AgentError) {
            assertEquals("STALE_SNAPSHOT", error.code)
            assertEquals(reason.name, error.reason)
            assertTrue(error.retryable)
        }
    }

    @Test fun formatterFreeDigestPreservesTheExistingFingerprintBytes() {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", snapshotFingerprintDigest(listOf("abc")))
        val fields = listOf("合成应用", null, "", "中文测试", "[0,0][100,100]", true, false, 3)
        val expected = BigInteger(1, MessageDigest.getInstance("SHA-256").digest(fields.joinToString("\u0000").toByteArray(Charsets.UTF_8)))
            .toString(16).padStart(64, '0')
        assertEquals(expected, snapshotFingerprintDigest(fields))
        assertEquals(64, snapshotFingerprintDigest(fields).length)
    }

    @Test fun fullTextBeyondTheReturnedUiCapStillChangesTheFingerprint() {
        val prefix = "合".repeat(1000)
        assertNotEquals(snapshotFingerprintDigest(listOf(prefix + "甲")), snapshotFingerprintDigest(listOf(prefix + "乙")))
        assertNotEquals(snapshotFingerprintDigest(listOf("合成描述")), snapshotFingerprintDigest(listOf("另一个描述")))
    }

    @Test fun identicalCompleteTraversalPassesWithoutAnotherJsonTree() {
        val validator = validator()
        for (node in listOf(root, first, second)) validator.accept(node.path, node.fingerprint.copy())
        validator.finish()
        assertEquals(3, validator.count)
    }

    @Test fun contentBoundsStateAndChildCountChangesFailAtTheChangedNode() {
        val changes = listOf(
            SnapshotStaleReason.NODE_CONTENT_CHANGED to original.copy(digest = "changed-synthetic-digest"),
            SnapshotStaleReason.NODE_BOUNDS_CHANGED to original.copy(bounds = listOf(0, 1, 100, 101)),
            SnapshotStaleReason.NODE_STATE_CHANGED to original.copy(stateBits = 7),
            SnapshotStaleReason.TREE_STRUCTURE_CHANGED to original.copy(childCount = 1),
        )
        for ((reason, changed) in changes) {
            val validator = validator()
            validator.accept(root.path, root.fingerprint)
            failure(reason) { validator.accept(first.path, changed) }
            assertEquals("The mismatch is rejected before consuming later nodes", 1, validator.count)
        }
    }

    @Test fun everyCapturedStateBitIsComparedEvenWhenTheDigestValueIsAccidentallyReused() {
        for (bit in 0 until 10) {
            val validator = validator()
            validator.accept(root.path, root.fingerprint)
            failure(SnapshotStaleReason.NODE_STATE_CHANGED) {
                validator.accept(first.path, original.copy(stateBits = original.stateBits xor (1 shl bit)))
            }
        }
    }

    @Test fun reorderedOrMovedPathsAreNotReboundToLookalikeNodes() {
        for (path in listOf(listOf(1), listOf(0, 0), emptyList())) {
            val validator = validator()
            validator.accept(root.path, root.fingerprint)
            failure(SnapshotStaleReason.TREE_STRUCTURE_CHANGED) { validator.accept(path, first.fingerprint) }
        }
    }

    @Test fun missingAndAdditionalNodesAreRejected() {
        val missing = validator()
        missing.accept(root.path, root.fingerprint)
        missing.accept(first.path, first.fingerprint)
        failure(SnapshotStaleReason.TREE_STRUCTURE_CHANGED) { missing.finish() }

        val additional = validator()
        for (node in listOf(root, first, second)) additional.accept(node.path, node.fingerprint)
        failure(SnapshotStaleReason.TREE_STRUCTURE_CHANGED) { additional.accept(listOf(2), original) }
    }

    @Test fun incompleteReferenceOrTruncatedCurrentTraversalNeverAuthorizesAnAction() {
        failure(SnapshotStaleReason.TREE_INCOMPLETE) { StreamingSnapshotValidator(listOf(root), complete = false) }
        val truncated = validator()
        truncated.accept(root.path, root.fingerprint)
        failure(SnapshotStaleReason.TREE_INCOMPLETE) { truncated.incomplete() }
    }

    @Test fun serializedDiagnosticsContainOnlyWhitelistedFixedReasons() {
        for (reason in SnapshotStaleReason.entries) {
            val result = staleSnapshot(reason).toJson()
            assertEquals(reason.name, result.getJSONObject("details").getString("reason"))
            assertEquals(1, result.getJSONObject("details").length())
        }
        assertFalse(AgentError("STALE_SNAPSHOT", "Synthetic failure", true, "synthetic-private-ui").toJson().has("details"))
        assertFalse(AgentError("OTHER_ERROR", "Synthetic failure", false, SnapshotStaleReason.NODE_CONTENT_CHANGED.name).toJson().has("details"))
        assertFalse(AgentError("STALE_SNAPSHOT", "Legacy failure", true).toJson().has("details"))
    }
    @Test fun unavailableChildrenGetOnlyOneFreshReadButCapacityTruncationDoesNot() {
        data class Read(val missingChild: Boolean, val truncated: Boolean, val capacityTruncated: Boolean = false)
        val reads = mutableListOf<Boolean>()
        val stillIncomplete = captureWithMissingChildRecovery({ refresh ->
            reads.add(refresh); Read(missingChild = true, truncated = true)
        }, { it.missingChild && !it.capacityTruncated })
        assertEquals(listOf(false, true), reads)
        assertTrue(stillIncomplete.truncated)
        reads.clear()
        val capacityTruncation = captureWithMissingChildRecovery({ refresh ->
            reads.add(refresh); Read(missingChild = true, truncated = true, capacityTruncated = true)
        }, { it.missingChild && !it.capacityTruncated })
        assertEquals(listOf(false), reads)
        assertTrue(capacityTruncation.truncated)
        reads.clear()
        val recovered = captureWithMissingChildRecovery({ refresh ->
            reads.add(refresh); Read(missingChild = !refresh, truncated = !refresh)
        }, { it.missingChild && !it.capacityTruncated })
        assertEquals(listOf(false, true), reads)
        assertFalse(recovered.truncated)
    }

}
