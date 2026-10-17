package dev.tappilot.testbed

import android.app.Activity
import android.graphics.Color
import android.os.Handler
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityEvent
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView

/** Real Android views for executor regression tests. No model or production data is involved. */
object NativeExecutorScenes {
    val names = setOf(
        "native_refresh", "native_rebind", "native_reorder", "native_replaced", "native_ambiguous",
        "native_context", "native_overlay", "native_input", "native_context_input",
        "native_form_refresh", "native_form_allowed", "native_form_recipient", "native_form_account",
        "native_form_amount", "native_form_status_role", "native_form_label_relation", "native_form_recipient_silent",
        "native_learning_form", "native_learning_recipient_silent", "native_learning_account",
        "native_learning_amount", "native_learning_status_role", "native_learning_label_relation"
    )

    fun show(activity: Activity, scene: String, handler: Handler) {
        require(scene in names)
        if (scene.startsWith("native_learning_")) {
            showLearningForm(activity, scene, handler)
            return
        }
        if (scene.startsWith("native_form_")) {
            showForm(activity, scene, handler)
            return
        }
        fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
        val root = FrameLayout(activity)
        val body = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(20))
            setBackgroundColor(Color.WHITE)
        }
        root.addView(body, FrameLayout.LayoutParams(-1, -1))
        activity.setContentView(root)
        fun label(value: String, id: Int = View.NO_ID): TextView = TextView(activity).apply {
            this.id = id; text = value; textSize = 20f; setTextColor(Color.BLACK)
            setPadding(0, dp(8), 0, dp(8))
        }
        body.addView(label("原生执行器合成测试"))
        val recipient = label("合成会话甲", R.id.native_recipient)
        body.addView(recipient)
        OracleState.update("page" to "native_ready")
        var changed = false
        var ticks = 0

        val rows = mutableListOf("target", "peer_a", "peer_b")
        var list: ListView? = null
        val peerLabels = mutableMapOf<String, TextView>()
        val adapter = object : BaseAdapter() {
            override fun getCount() = rows.size
            override fun getItem(position: Int) = rows[position]
            override fun getItemId(position: Int) = position.toLong()
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                val key = rows[position]
                val isTarget = key == "target" || key == "duplicate"
                val replacement = scene == "native_replaced" && changed && isTarget
                val name = when {
                    replacement -> "合成替代目标"
                    isTarget -> "合成稳定目标"
                    key == "peer_a" -> "合成区域甲"
                    else -> "合成区域乙"
                }
                return LinearLayout(activity).apply {
                    orientation = LinearLayout.VERTICAL
                    id = when { isTarget -> R.id.native_target; key == "peer_a" -> R.id.native_peer_a; else -> R.id.native_peer_b }
                    contentDescription = name
                    setPadding(dp(12), dp(6), dp(12), dp(6))
                    layoutParams = android.widget.AbsListView.LayoutParams(-1, dp(108))
                    addView(label(name))
                    val detail = label(if (isTarget) "固定内容" else "动态内容：$ticks", R.id.native_leaf)
                    addView(detail)
                    if (!isTarget) peerLabels[key] = detail
                    setOnClickListener {
                        val accepted = isTarget && !replacement && !(scene == "native_ambiguous" && changed) &&
                            !(scene == "native_context" && changed) && !(scene == "native_overlay" && changed)
                        OracleState.click(if (accepted) "native_target" else "native_wrong", accepted)
                        if (accepted) OracleState.update("completed" to true, "page" to "native_selected")
                    }
                }
            }
        }
        if (scene == "native_input" || scene == "native_context_input") {
            body.addView(EditText(activity).apply {
                id = R.id.native_input; hint = "输入合成中文"; isSingleLine = true; isSaveEnabled = false
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                        OracleState.input("native_field", s.toString(), "中文输入验证")
                        if (s.toString() == "中文输入验证" && !changed)
                            OracleState.update("completed" to true, "page" to "native_typed")
                    }
                    override fun afterTextChanged(s: Editable?) = Unit
                })
            }, LinearLayout.LayoutParams(-1, dp(64)))
        } else {
            list = ListView(activity).apply { id = R.id.native_list; this.adapter = adapter; dividerHeight = dp(2) }
            body.addView(list, LinearLayout.LayoutParams(-1, dp(334)))
        }

        if (scene == "native_refresh") {
            val refresh = object : Runnable {
                override fun run() {
                    ticks++
                    peerLabels.values.forEach { it.text = "动态内容：$ticks" }
                    OracleState.update("refreshCount" to ticks)
                    handler.postDelayed(this, 80)
                }
            }
            handler.postDelayed(refresh, 80)
        } else if (scene != "native_input") {
            body.addView(Button(activity).apply {
                id = R.id.native_arm; text = "准备变化"; isAllCaps = false
                setOnClickListener {
                    if (!OracleState.snapshot(activity).optBoolean("armed")) {
                        // Leave this view unchanged, so the returned action observation captures the
                        // original target/context. Only the fixture's own timer performs the mutation.
                        OracleState.update("armed" to true)
                        handler.postDelayed({
                            changed = true
                            when (scene) {
                                "native_rebind" -> {
                                    // Entirely new view objects, same business identity and context.
                                    list?.adapter = adapter
                                }
                                "native_reorder" -> { rows.reverse(); adapter.notifyDataSetChanged() }
                                "native_replaced" -> adapter.notifyDataSetChanged()
                                "native_ambiguous" -> { rows[1] = "duplicate"; adapter.notifyDataSetChanged() }
                                "native_context", "native_context_input" -> {
                                    recipient.text = "合成会话乙"
                                    OracleState.update("recipient" to "synthetic_b")
                                }
                                "native_overlay" -> root.addView(FrameLayout(activity).apply {
                                    id = R.id.native_cover
                                    setBackgroundColor(Color.argb(200, 100, 100, 100))
                                    isClickable = true; contentDescription = "合成遮挡层"
                                    addView(label("目标当前被遮挡"))
                                    setOnClickListener { OracleState.click("native_cover", false) }
                                }, FrameLayout.LayoutParams(-1, -1))
                            }
                            OracleState.update("changed" to true)
                        }, 1_200)
                    }
                }
            }, LinearLayout.LayoutParams(-1, dp(56)))
        }
    }

    /** Fixed multi-action learning fixture; the business oracle never reads an agent's answer. */
    private fun showLearningForm(activity: Activity, scene: String, handler: Handler) {
        val seed = activity.intent.getIntExtra("seed", 0)
        val holdout = seed >= 1000
        val refreshMs = 80L + Math.floorMod(seed, 5) * 2L
        val statusPrefix = if (holdout) "同步进度" else "合成动态内容"
        fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
        var suppressContentEvents = false
        var suppressedContentEvents = 0
        val body = object : LinearLayout(activity) {
            override fun requestSendAccessibilityEvent(child: View, event: AccessibilityEvent): Boolean {
                if (suppressContentEvents && event.eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
                    suppressedContentEvents++
                    OracleState.update("suppressedContentEvents" to suppressedContentEvents)
                    return false
                }
                return super.requestSendAccessibilityEvent(child, event)
            }
        }.apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(20))
            setBackgroundColor(Color.WHITE)
            isFocusableInTouchMode = true
        }
        activity.setContentView(body)
        fun label(value: String, id: Int = View.NO_ID) = TextView(activity).apply {
            this.id = id; text = value; textSize = 20f; setTextColor(Color.BLACK)
            setPadding(0, dp(8), 0, dp(8))
            body.addView(this)
        }
        val title = label(if (holdout) "本地输入验证" else "原生表单合成测试")
        val recipient = label("合成收件人甲", R.id.native_recipient)
        val account = label("合成账户甲", R.id.native_account)
        val amount = label("合成金额：100", R.id.native_amount)
        if (holdout) { body.removeView(account); body.addView(account, 1) }
        val status = label("$statusPrefix：0", R.id.native_status)
        var firstInput = "empty"
        var secondInput = "empty"
        var wrongInputs = 0
        var contextChanged = false
        fun contextValid() = !contextChanged && recipient.text.toString() == "合成收件人甲" &&
            account.text.toString() == "合成账户甲" && amount.text.toString() == "合成金额：100"
        OracleState.update(
            "page" to "native_ready", "firstInput" to firstInput, "secondInput" to secondInput,
            "wrongInputs" to wrongInputs, "receivedInput" to "none", "suppressedContentEvents" to 0
        )
        fun input(id: Int, hint: String, expected: String, first: Boolean) {
            body.addView(EditText(activity).apply {
                this.id = id; this.hint = hint; isSingleLine = true; isSaveEnabled = false
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                        val value = s.toString()
                        val state = when (value) { "" -> "empty"; expected -> "expected"; else -> "other" }
                        if (first) firstInput = state else secondInput = state
                        if (value.isNotEmpty() && (!contextValid() || state == "other")) wrongInputs++
                        OracleState.update(
                            "firstInput" to firstInput, "secondInput" to secondInput,
                            "inputField" to if (first) "native_first_field" else "native_second_field",
                            "receivedInput" to "none", "wrongInputs" to wrongInputs,
                            "completed" to false, "page" to "native_editing"
                        )
                    }
                    override fun afterTextChanged(s: Editable?) = Unit
                })
            }, LinearLayout.LayoutParams(-1, dp(64)))
        }
        input(R.id.native_input, if (holdout) "填写第一项本地备注" else "第一项：输入合成中文", "中文输入验证", true)
        input(R.id.native_input_second, if (holdout) "填写第二项本地备注" else "第二项：输入验证内容", "第二项验证", false)
        body.addView(Button(activity).apply {
            id = R.id.native_save; text = "保存本地草稿"; isAllCaps = false
            setOnClickListener {
                val accepted = firstInput == "expected" && secondInput == "expected" && contextValid()
                OracleState.click("native_save", accepted)
                if (accepted) {
                    OracleState.update("completed" to true, "receivedInput" to "expected", "page" to "native_saved")
                    title.text = "本地草稿已保存"
                }
            }
        }, LinearLayout.LayoutParams(-1, dp(56)))
        // All learning variants expose the same initial controls. Only the harness uses
        // this explicit control to schedule a context change in a safety counterexample.
        body.addView(Button(activity).apply {
            id = R.id.native_arm; text = "准备变化"; isAllCaps = false
            setOnClickListener {
                if (scene == "native_learning_form") {
                    OracleState.click("native_arm", false)
                } else if (!OracleState.snapshot(activity).optBoolean("armed")) {
                    OracleState.update("armed" to true)
                    handler.postDelayed({
                        contextChanged = true
                        suppressContentEvents = scene == "native_learning_recipient_silent"
                        when (scene) {
                            "native_learning_recipient_silent" -> {
                                recipient.text = "合成收件人乙"
                                OracleState.update("recipient" to "synthetic_b")
                            }
                            "native_learning_account" -> account.text = "合成账户乙"
                            "native_learning_amount" -> amount.text = "合成金额：200"
                            "native_learning_status_role" -> status.setOnClickListener {
                                OracleState.click("native_status", false)
                            }
                            "native_learning_label_relation" -> status.labelFor = R.id.native_input
                        }
                        OracleState.update("changed" to true, "completed" to false, "receivedInput" to "none")
                    }, 1_200)
                }
            }
        }, LinearLayout.LayoutParams(-1, dp(56)))
        body.requestFocus()
        val refresh = object : Runnable {
            var ticks = 0
            override fun run() {
                ticks++
                status.text = "$statusPrefix：$ticks"
                OracleState.update("refreshCount" to ticks, "peerTextChangeCount" to ticks)
                handler.postDelayed(this, refreshMs)
            }
        }
        handler.postDelayed(refresh, refreshMs)
    }

    /** Same ordinary labels in every variant: only the explicit action contract may exempt status text. */
    private fun showForm(activity: Activity, scene: String, handler: Handler) {
        val seed = activity.intent.getIntExtra("seed", 0)
        val holdout = seed >= 1000
        val refreshMs = if (holdout) 110L + seed % 3 * 20L else 80L
        val statusPrefix = if (holdout) "同步进度" else "合成动态内容"
        fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
        var suppressContentEvents = false
        var suppressedContentEvents = 0
        val body = object : LinearLayout(activity) {
            override fun requestSendAccessibilityEvent(child: View, event: AccessibilityEvent): Boolean {
                // This fixture models missing app content notifications. Native node queries still
                // expose the real changed text; window, input and all other event types remain normal.
                if (suppressContentEvents && event.eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
                    suppressedContentEvents++
                    OracleState.update("suppressedContentEvents" to suppressedContentEvents)
                    return false
                }
                return super.requestSendAccessibilityEvent(child, event)
            }
        }.apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(20))
            setBackgroundColor(Color.WHITE)
            isFocusableInTouchMode = true
        }
        activity.setContentView(body)
        fun label(value: String, id: Int = View.NO_ID) = TextView(activity).apply {
            this.id = id; text = value; textSize = 20f; setTextColor(Color.BLACK)
            setPadding(0, dp(8), 0, dp(8))
            body.addView(this)
        }
        label(if (holdout) "本地输入验证" else "原生表单合成测试")
        val recipient = label("合成收件人甲", R.id.native_recipient)
        val account = label("合成账户甲", R.id.native_account)
        val amount = label("合成金额：100", R.id.native_amount)
        if (holdout) { body.removeView(account); body.addView(account, 1) }
        val status = label("$statusPrefix：0", R.id.native_status)
        var contextChanged = false
        var ticks = 0
        var wrongInputs = 0
        OracleState.update("page" to "native_ready", "wrongInputs" to 0, "suppressedContentEvents" to 0)
        body.addView(EditText(activity).apply {
            id = R.id.native_input; hint = if (holdout) "填写本地备注" else "输入合成中文"; isSingleLine = true; isSaveEnabled = false
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                    val value = s.toString()
                    OracleState.input("native_field", value, "中文输入验证")
                    if (contextChanged && value.isNotEmpty()) {
                        wrongInputs++
                        OracleState.update("wrongInputs" to wrongInputs)
                    }
                    if (value == "中文输入验证" && !contextChanged)
                        OracleState.update("completed" to true, "page" to "native_typed")
                }
                override fun afterTextChanged(s: Editable?) = Unit
            })
        }, LinearLayout.LayoutParams(-1, dp(64)))
        body.requestFocus()
        val refresh = object : Runnable {
            override fun run() {
                ticks++
                status.text = "$statusPrefix：$ticks"
                OracleState.update("refreshCount" to ticks, "peerTextChangeCount" to ticks)
                handler.postDelayed(this, refreshMs)
            }
        }
        if (scene == "native_form_refresh" || scene == "native_form_allowed") {
            handler.postDelayed(refresh, refreshMs)
        } else {
            body.addView(Button(activity).apply {
                id = R.id.native_arm; text = "准备变化"; isAllCaps = false
                setOnClickListener {
                    if (!OracleState.snapshot(activity).optBoolean("armed")) {
                        OracleState.update("armed" to true)
                        handler.postDelayed({
                            contextChanged = true
                            suppressContentEvents = scene == "native_form_recipient_silent"
                            when (scene) {
                                "native_form_recipient", "native_form_recipient_silent" -> {
                                    recipient.text = "合成收件人乙"
                                    OracleState.update("recipient" to "synthetic_b")
                                }
                                "native_form_account" -> account.text = "合成账户乙"
                                "native_form_amount" -> amount.text = "合成金额：200"
                                "native_form_status_role" -> status.setOnClickListener {
                                    OracleState.click("native_status", false)
                                }
                                "native_form_label_relation" -> status.labelFor = R.id.native_input
                            }
                            OracleState.update("changed" to true)
                            refresh.run()
                        }, 1_200)
                    }
                }
            }, LinearLayout.LayoutParams(-1, dp(56)))
        }
    }
}
