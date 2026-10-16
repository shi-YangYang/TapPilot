package dev.tappilot.agent

import android.animation.ValueAnimator
import android.content.Context
import android.view.Choreographer
import android.widget.Button
import kotlin.math.abs
import kotlin.math.min

/** Native equivalent of beUI's spring tokens; no web runtime or extra dependency. */
internal class UiSpring(
    private val stiffness: Float,
    private val damping: Float,
    private val mass: Float,
    initialValue: Float,
    private val apply: (Float) -> Unit
) : Choreographer.FrameCallback {
    private val choreographer = Choreographer.getInstance()
    private var value = initialValue
    private var target = initialValue
    private var velocity = 0f
    private var lastFrame = 0L
    private var elapsed = 0f
    private var running = false

    fun to(next: Float, animate: Boolean = true) {
        target = next
        if (!animate || !ValueAnimator.areAnimatorsEnabled()) {
            cancel(); value = next; velocity = 0f; apply(next)
        } else if (!running) {
            running = true; lastFrame = 0L; elapsed = 0f
            choreographer.postFrameCallback(this)
        }
    }

    override fun doFrame(frameTimeNanos: Long) {
        if (!running) return
        if (!ValueAnimator.areAnimatorsEnabled()) { to(target, false); return }
        var remaining = if (lastFrame == 0L) 1f / 60f else min((frameTimeNanos - lastFrame) / 1_000_000_000f, 0.032f)
        lastFrame = frameTimeNanos
        elapsed += remaining
        // Short integration steps stay stable on a delayed UI frame.
        while (remaining > 0f) {
            val step = min(remaining, 1f / 240f)
            velocity += (-stiffness * (value - target) - damping * velocity) / mass * step
            value += velocity * step
            remaining -= step
        }
        if ((abs(value - target) < 0.001f && abs(velocity) < 0.01f) || elapsed >= 1.5f) {
            value = target; velocity = 0f; running = false
        }
        apply(value)
        if (running) choreographer.postFrameCallback(this)
    }

    fun cancel() {
        choreographer.removeFrameCallback(this)
        running = false
    }
}

/** Button/base.tsx: scale .93, SPRING_PRESS 500 / 30 / .6. */
internal class BeUiButton(context: Context) : Button(context) {
    private var spring: UiSpring? = null

    override fun setPressed(pressed: Boolean) {
        super.setPressed(pressed)
        val target = if (pressed && isEnabled) 0.93f else 1f
        if (!isAttachedToWindow) { scaleX = target; scaleY = target; return }
        val motion = spring ?: UiSpring(500f, 30f, 0.6f, scaleX) { scaleX = it; scaleY = it }.also { spring = it }
        motion.to(target)
    }

    override fun onDetachedFromWindow() {
        spring?.cancel(); scaleX = 1f; scaleY = 1f
        super.onDetachedFromWindow()
    }
}
