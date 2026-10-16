package dev.tappilot.agent

import java.util.concurrent.atomic.AtomicReference

/** A whole local run or wireless session owns automation until explicitly released. */
internal object AutomationOwner {
    private val owner = AtomicReference<Any?>(null)
    fun acquire(token: Any): Boolean = owner.compareAndSet(null, token)
    fun release(token: Any) { owner.compareAndSet(token, null) }
    fun busy(): Boolean = owner.get() != null
}
