package dev.tappilot.testbed

import org.json.JSONObject

/** Bounded, reproducible fixture configuration. These values are never production user data. */
data class ScenarioVariant(
    val id: String,
    val scene: String,
    val seed: Int,
    val labels: Labels,
    val layout: String,
    val targetIndex: Int,
    val itemCount: Int,
    val delayMs: Int,
    val refreshMs: Int,
    val refreshCount: Int,
    val refreshMode: String,
    val reverse: Boolean,
) {
    data class Labels(val target: String, val decoy: String, val open: String, val search: String,
        val save: String, val dismiss: String, val input: String, val recipient: String)

    companion object {
        val scenes = setOf("navigation", "search", "async_list", "ime", "overlay", "long_list", "webview", "canvas")
        private val keys = setOf("schemaVersion", "id", "scene", "seed", "labels", "layout", "targetIndex", "itemCount",
            "delayMs", "refreshMs", "refreshCount", "refreshMode", "reverse")
        private val labelKeys = setOf("target", "decoy", "open", "search", "save", "dismiss", "input", "recipient")

        fun parse(raw: String, expectedScene: String, expectedSeed: Int): ScenarioVariant {
            require(raw.length <= 4096)
            val value = JSONObject(raw)
            require(value.keys().asSequence().toSet() == keys)
            fun integer(key: String, range: IntRange): Int {
                val number = value.get(key)
                require(number is Int && number in range)
                return number
            }
            fun string(key: String): String {
                val text = value.get(key)
                require(text is String)
                return text
            }
            require(integer("schemaVersion", 1..1) == 1)
            val id = string("id")
            require(id.length in 1..96 && id.matches(Regex("[a-z0-9_-]+")))
            val scene = string("scene")
            require(scene in scenes && scene == expectedScene)
            val seed = integer("seed", 0..Int.MAX_VALUE)
            require(seed == expectedSeed)
            val labels = value.getJSONObject("labels")
            require(labels.keys().asSequence().toSet() == labelKeys)
            fun label(key: String): String {
                val text = labels.get(key)
                require(text is String && text.length in 1..80 && text.none { it.isISOControl() })
                return text
            }
            val parsedLabels = Labels(label("target"), label("decoy"), label("open"), label("search"),
                label("save"), label("dismiss"), label("input"), label("recipient"))
            require(parsedLabels.target != parsedLabels.decoy)
            val layout = string("layout")
            require(layout in setOf("plain", "parent_label", "compact"))
            val itemCount = integer("itemCount", 3..80)
            val targetIndex = integer("targetIndex", 1..itemCount)
            val refreshMode = string("refreshMode")
            require(refreshMode in setOf("none", "peer_text", "reorder", "replace"))
            val reverse = value.get("reverse")
            require(reverse is Boolean)
            return ScenarioVariant(id, scene, seed, parsedLabels, layout, targetIndex, itemCount,
                integer("delayMs", 0..1200), integer("refreshMs", 80..1200), integer("refreshCount", 0..600),
                refreshMode, reverse)
        }
    }
}
