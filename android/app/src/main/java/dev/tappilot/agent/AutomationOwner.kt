package dev.tappilot.agent

import java.util.concurrent.atomic.AtomicReference

/** A wireless session owns automation until released, excluding simultaneous ADB actions. */
internal object AutomationOwner {
    private val owner = AtomicReference<Any?>(null)
    fun acquire(token: Any): Boolean = owner.compareAndSet(null, token)
    fun release(token: Any) { owner.compareAndSet(token, null) }
    fun busy(): Boolean = owner.get() != null
}
