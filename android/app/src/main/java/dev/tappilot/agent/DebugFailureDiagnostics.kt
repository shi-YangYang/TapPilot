package dev.tappilot.agent

/** Debug-build diagnostics contain code locations only, never exception text,
 * parameters, UI values, causes or Throwable.toString()/printStackTrace(). */
internal object DebugFailureDiagnostics {
    private fun symbol(value: String?, fallback: String): String =
        value?.takeIf { it.length in 1..240 && it.all { ch -> ch.isLetterOrDigit() || ch in "_.$/<>-" } } ?: fallback

    fun codeLocations(error: Throwable): String {
        val name = symbol(error.javaClass.name, "UnknownException")
        val frames = error.stackTrace.take(16).joinToString("\n") { frame ->
            val owner = symbol(frame.className, "UnknownClass")
            val method = symbol(frame.methodName, "UnknownMethod")
            val file = symbol(frame.fileName, "UnknownFile")
            "$owner.$method($file:${frame.lineNumber})"
        }
        return "ANDROID_ERROR class=$name\n$frames"
    }
}
