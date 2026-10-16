package dev.tappilot.agent

import org.json.JSONObject

/** Executes a computer request while its transport session remains valid. */
internal fun interface PhoneExecutor {
    fun execute(name: String, arguments: JSONObject, canContinue: () -> Boolean): JSONObject
}
