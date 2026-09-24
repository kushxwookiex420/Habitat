package com.habitat.core

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.*
import android.text.InputType

class MainActivity : Activity() {

    private lateinit var root: LinearLayout
    private lateinit var brainAdapter: BrainAdapter

    private val bg = Color.rgb(10, 11, 15)
    private val panel = Color.rgb(20, 22, 28)
    private val panel2 = Color.rgb(27, 30, 38)
    private val inputBg = Color.rgb(31, 34, 42)

    private val white = Color.rgb(242, 244, 248)
    private val muted = Color.rgb(145, 151, 163)
    private val blue = Color.rgb(80, 180, 255)
    private val green = Color.rgb(105, 220, 165)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.setSoftInputMode(
            WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(true)
        }

        brainAdapter = BrainAdapter(this)

        showChatHome()
    }

    override fun onDestroy() {
        try {
            brainAdapter.shutdown()
        } catch (_: Exception) {
        }

        super.onDestroy()
    }

    private fun dp(value: Int): Int {
        return (value * resources.displayMetrics.density).toInt()
    }

    private fun createRoot(): LinearLayout {

        val r = LinearLayout(this)

        r.orientation = LinearLayout.VERTICAL
        r.setBackgroundColor(bg)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {

            r.setOnApplyWindowInsetsListener { view, insets ->

                val systemBars = insets.getInsets(
                    WindowInsets.Type.systemBars()
                )

                view.setPadding(
                    dp(10),
                    systemBars.top,
                    dp(10),
                    systemBars.bottom
                )

                insets
            }
        }

        return r
    }

    private fun startScreen() {

        root = createRoot()

        setContentView(root)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            root.requestApplyInsets()
        }
    }

    private fun topBar(
        title: String,
        subtitle: String = "AX • ONLINE"
    ): LinearLayout {

        val bar = LinearLayout(this)

        bar.orientation = LinearLayout.HORIZONTAL
        bar.gravity = Gravity.CENTER_VERTICAL

        bar.setPadding(
            dp(4),
            dp(10),
            dp(4),
            dp(10)
        )

        val menu = TextView(this)

        menu.text = "☰"
        menu.setTextColor(white)
        menu.textSize = 25f
        menu.gravity = Gravity.CENTER

        menu.setOnClickListener {
            showMenu()
        }

        bar.addView(
            menu,
            LinearLayout.LayoutParams(
                dp(48),
                dp(48)
            )
        )

        val titles = LinearLayout(this)

        titles.orientation = LinearLayout.VERTICAL

        val mainTitle = TextView(this)

        mainTitle.text = title
        mainTitle.setTextColor(white)
        mainTitle.textSize = 19f

        mainTitle.setTypeface(
            null,
            android.graphics.Typeface.BOLD
        )

        val sub = TextView(this)

        sub.text = subtitle
        sub.setTextColor(green)
        sub.textSize = 11f

        titles.addView(mainTitle)
        titles.addView(sub)

        bar.addView(
            titles,
            LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
            )
        )

        val status = TextView(this)

        status.text = "●"
        status.setTextColor(green)
        status.textSize = 18f
        status.gravity = Gravity.CENTER

        bar.addView(
            status,
            LinearLayout.LayoutParams(
                dp(40),
                dp(48)
            )
        )

        return bar
    }

    private fun showChatHome() {

        startScreen()

        root.addView(
            topBar("HABITAT")
        )

        val chatScroll = ScrollView(this)

        chatScroll.isFillViewport = true

        val messages = LinearLayout(this)

        messages.orientation = LinearLayout.VERTICAL

        messages.setPadding(
            dp(6),
            dp(12),
            dp(6),
            dp(18)
        )

        val welcome = LinearLayout(this)

        welcome.orientation = LinearLayout.VERTICAL
        welcome.gravity = Gravity.CENTER

        welcome.setPadding(
            dp(20),
            dp(30),
            dp(20),
            dp(30)
        )

        val habitat = TextView(this)

        habitat.text = "HABITAT"
        habitat.setTextColor(white)
        habitat.textSize = 30f
        habitat.gravity = Gravity.CENTER

        habitat.setTypeface(
            null,
            android.graphics.Typeface.BOLD
        )

        val ax = TextView(this)

        ax.text = "AX CORE"
        ax.setTextColor(blue)
        ax.textSize = 14f
        ax.gravity = Gravity.CENTER

        val description = TextView(this)

        description.text =
            "Your AI operating environment"

        description.setTextColor(muted)
        description.textSize = 14f
        description.gravity = Gravity.CENTER

        welcome.addView(habitat)
        welcome.addView(ax)
        welcome.addView(description)

        messages.addView(welcome)

        messages.addView(
            bubble(
                "AX",
                "Habitat online.\n\nWhat are we working on?",
                false
            )
        )

        chatScroll.addView(messages)

        root.addView(
            chatScroll,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )

        val composerOuter = LinearLayout(this)

        composerOuter.orientation =
            LinearLayout.VERTICAL

        composerOuter.setPadding(
            dp(4),
            dp(6),
            dp(4),
            dp(8)
        )

        val composer = LinearLayout(this)

        composer.orientation =
            LinearLayout.HORIZONTAL

        composer.gravity =
            Gravity.CENTER_VERTICAL

        val input = EditText(this)

        input.hint = "Message Ax..."
        input.hintTextColor = muted
        input.setTextColor(white)

        input.textSize = 16f

        input.inputType =
            InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_MULTI_LINE or
            InputType.TYPE_TEXT_FLAG_CAP_SENTENCES

        input.gravity =
            Gravity.CENTER_VERTICAL or
            Gravity.START

        input.setSingleLine(false)
        input.maxLines = 5

        input.setPadding(
            dp(17),
            dp(8),
            dp(12),
            dp(8)
        )

        val inputShape = GradientDrawable()

        inputShape.cornerRadius =
            dp(24).toFloat()

        inputShape.setColor(inputBg)

        input.background = inputShape

        composer.addView(
            input,
            LinearLayout.LayoutParams(
                0,
                dp(58),
                1f
            )
        )

        val send = TextView(this)

        send.text = "↑"
        send.setTextColor(Color.WHITE)
        send.textSize = 25f
        send.gravity = Gravity.CENTER

        send.setTypeface(
            null,
            android.graphics.Typeface.BOLD
        )

        val sendShape = GradientDrawable()

        sendShape.shape =
            GradientDrawable.OVAL

        sendShape.setColor(blue)

        send.background = sendShape

        val sendParams = LinearLayout.LayoutParams(
            dp(52),
            dp(52)
        )

        sendParams.setMargins(
            dp(8),
            0,
            0,
            0
        )

        composer.addView(
            send,
            sendParams
        )

        composerOuter.addView(
            composer,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(62)
            )
        )

        root.addView(
            composerOuter,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(76)
            )
        )

        fun sendMessage() {

            val message =
                input.text.toString().trim()

            if (message.isEmpty()) {
                return
            }

            messages.addView(
                bubble(
                    "YOU",
                    message,
                    true
                )
            )

            input.setText("")

            chatScroll.post {
                chatScroll.fullScroll(
                    View.FOCUS_DOWN
                )
            }

            val thinking =
                bubble(
                    "AX",
                    "Thinking…",
                    false
                )

            messages.addView(thinking)

            chatScroll.post {
                chatScroll.fullScroll(
                    View.FOCUS_DOWN
                )
            }

            // CURRENT BrainAdapter API
            brainAdapter.send(message) { result ->

                runOnUiThread {

                    when (result.state) {

                        BrainAdapter.State.CONNECTED -> {

                            messages.removeView(
                                thinking
                            )

                            messages.addView(
                                bubble(
                                    "AX",
                                    result.text,
                                    false
                                )
                            )

                            chatScroll.post {
                                chatScroll.fullScroll(
                                    View.FOCUS_DOWN
                                )
                            }
                        }

                        BrainAdapter.State.ERROR -> {

                            messages.removeView(
                                thinking
                            )

                            messages.addView(
                                bubble(
                                    "AX",
                                    "I couldn't complete that request.\n\n${result.detail}",
                                    false
                                )
                            )

                            chatScroll.post {
                                chatScroll.fullScroll(
                                    View.FOCUS_DOWN
                                )
                            }
                        }

                        BrainAdapter.State.CONNECTING,
                        BrainAdapter.State.DISCONNECTED -> {
                            // Keep thinking bubble visible.
                        }
                    }
                }
            }
        }

        send.setOnClickListener {
            sendMessage()
        }

        input.setOnEditorActionListener { _, _, _ ->
            false
        }

        val imm = getSystemService(
            Context.INPUT_METHOD_SERVICE
        ) as InputMethodManager

        imm.hideSoftInputFromWindow(
            input.windowToken,
            0
        )
    }

    private fun bubble(
        speaker: String,
        message: String,
        user: Boolean
    ): LinearLayout {

        val wrapper = LinearLayout(this)

        wrapper.orientation =
            LinearLayout.VERTICAL

        wrapper.gravity =
            if (user) {
                Gravity.END
            } else {
                Gravity.START
            }

        wrapper.setPadding(
            dp(4),
            dp(6),
            dp(4),
            dp(6)
        )

        val name = TextView(this)

        name.text =
            if (user) "YOU" else "AX"

        name.setTextColor(
            if (user) blue else green
        )

        name.textSize = 10f

        name.setPadding(
            dp(5),
            0,
            dp(5),
            dp(4)
        )

        wrapper.addView(name)

        val body = TextView(this)

        body.text = message
        body.setTextColor(white)
        body.textSize = 16f

        body.setPadding(
            dp(16),
            dp(13),
            dp(16),
            dp(13)
        )

        val shape = GradientDrawable()

        shape.cornerRadius =
            dp(19).toFloat()

        shape.setColor(
            if (user) {
                Color.rgb(35, 57, 75)
            } else {
                panel
            }
        )

        body.background = shape

        val width =
            (resources.displayMetrics.widthPixels * 0.84f).toInt()

        wrapper.addView(
            body,
            LinearLayout.LayoutParams(
                width,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        return wrapper
    }

    private fun showMenu() {

        val dialog = Dialog(this)

        val box = LinearLayout(this)

        box.orientation =
            LinearLayout.VERTICAL

        box.setPadding(
            dp(18),
            dp(18),
            dp(18),
            dp(18)
        )

        val shape = GradientDrawable()

        shape.cornerRadius =
            dp(22).toFloat()

        shape.setColor(panel2)

        box.background = shape

        val title = TextView(this)

        title.text = "HABITAT"
        title.setTextColor(white)
        title.textSize = 21f

        title.setTypeface(
            null,
            android.graphics.Typeface.BOLD
        )

        box.addView(
            title,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(50)
            )
        )

        addMenuItem(box, "Chat with Ax") {
            dialog.dismiss()
            showChatHome()
        }

        addMenuItem(box, "Projects") {
            dialog.dismiss()
            showProjects()
        }

        addMenuItem(box, "Brain") {
            dialog.dismiss()
            showBrain()
        }

        addMenuItem(box, "Scenes") {
            dialog.dismiss()
            showScenes()
        }

        addMenuItem(box, "Systems") {
            dialog.dismiss()
            showSystems()
        }

        addMenuItem(box, "About Habitat") {
            dialog.dismiss()
            showAbout()
        }

        dialog.setContentView(box)

        dialog.show()

        dialog.window?.setBackgroundDrawableResource(
            android.R.color.transparent
        )

        dialog.window?.setLayout(
            dp(310),
            WindowManager.LayoutParams.WRAP_CONTENT
        )
    }

    private fun addMenuItem(
        parent: LinearLayout,
        label: String,
        action: () -> Unit
    ) {

        val item = TextView(this)

        item.text = label
        item.setTextColor(white)
        item.textSize = 16f
        item.gravity = Gravity.CENTER_VERTICAL

        item.setPadding(
            dp(14),
            0,
            dp(14),
            0
        )

        item.setOnClickListener {
            action()
        }

        parent.addView(
            item,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(52)
            )
        )
    }

    private fun showProjects() {

        startScreen()

        root.addView(
            topBar("PROJECTS")
        )

        val scroll = ScrollView(this)

        val list = LinearLayout(this)

        list.orientation =
            LinearLayout.VERTICAL

        list.setPadding(
            dp(4),
            dp(10),
            dp(4),
            dp(20)
        )

        list.addView(
            infoCard(
                "DropPilot AI",
                "AI commerce engine",
                "RESEARCH → SCORE → VERIFY → SELECT → LIST → MONITOR"
            )
        )

        list.addView(
            infoCard(
                "Vice City Files",
                "GTA 6 media engine",
                "RESEARCH → SCRIPT → CREATE → PUBLISH → ANALYZE"
            )
        )

        list.addView(
            infoCard(
                "Habitat",
                "AI operating environment",
                "UNDERSTAND → PLAN → ACT → OBSERVE → VERIFY → CONTINUE"
            )
        )

        scroll.addView(list)

        root.addView(
            scroll,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )
    }

    private fun showBrain() {

        startScreen()

        root.addView(
            topBar("AX BRAIN")
        )

        val scroll = ScrollView(this)

        val list = LinearLayout(this)

        list.orientation =
            LinearLayout.VERTICAL

        list.setPadding(
            dp(4),
            dp(10),
            dp(4),
            dp(20)
        )

        list.addView(
            infoCard(
                "BRAIN",
                "ONLINE",
                "BrainAdapter connected to the Habitat backend."
            )
        )

        list.addView(statusRow("Memory", "READY"))
        list.addView(statusRow("Reasoning", "READY"))
        list.addView(statusRow("Agents", "READY"))
        list.addView(statusRow("Tools", "READY"))
        list.addView(statusRow("Tasks", "READY"))

        val clear = TextView(this)

        clear.text =
            "CLEAR LOCAL CONVERSATION MEMORY"

        clear.setTextColor(
            Color.rgb(255, 145, 145)
        )

        clear.textSize = 13f
        clear.gravity = Gravity.CENTER

        clear.setOnClickListener {

            brainAdapter.clearMemory()

            Toast.makeText(
                this,
                "Local conversation memory cleared",
                Toast.LENGTH_SHORT
            ).show()
        }

        list.addView(
            clear,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(58)
            )
        )

        scroll.addView(list)

        root.addView(
            scroll,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )
    }

    private fun showScenes() {

        startScreen()

        root.addView(
            topBar("SCENES")
        )

        val scroll = ScrollView(this)

        val list = LinearLayout(this)

        list.orientation =
            LinearLayout.VERTICAL

        list.setPadding(
            dp(4),
            dp(10),
            dp(4),
            dp(20)
        )

        list.addView(
            infoCard(
                "COMMAND CENTER",
                "Habitat home",
                "Central environment for Ax and all active projects."
            )
        )

        list.addView(
            infoCard(
                "AX CHAT",
                "Conversation",
                "Direct communication with the Habitat intelligence layer."
            )
        )

        list.addView(
            infoCard(
                "PROJECT CONTROL",
                "Projects",
                "Manage DropPilot, Vice City Files and Habitat."
            )
        )

        list.addView(
            infoCard(
                "SYSTEM CONTROL",
                "Systems",
                "Agents, tasks, tools, memory and automation."
            )
        )

        scroll.addView(list)

        root.addView(
            scroll,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )
    }

    private fun showSystems() {

        startScreen()

        root.addView(
            topBar("SYSTEMS")
        )

        val scroll = ScrollView(this)

        val list = LinearLayout(this)

        list.orientation =
            LinearLayout.VERTICAL

        list.setPadding(
            dp(4),
            dp(10),
            dp(4),
            dp(20)
        )

        list.addView(statusRow("Memory", "READY"))
        list.addView(statusRow("Projects", "READY"))
        list.addView(statusRow("Agents", "READY"))
        list.addView(statusRow("Tasks", "READY"))
        list.addView(statusRow("Tools", "READY"))
        list.addView(statusRow("Brain", "ONLINE"))

        scroll.addView(list)

        root.addView(
            scroll,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )
    }

    private fun showAbout() {

        startScreen()

        root.addView(
            topBar("HABITAT")
        )

        val scroll = ScrollView(this)

        val list = LinearLayout(this)

        list.orientation =
            LinearLayout.VERTICAL

        list.setPadding(
            dp(4),
            dp(10),
            dp(4),
            dp(20)
        )

        list.addView(
            infoCard(
                "HABITAT v0.2.2",
                "AX AI OPERATING ENVIRONMENT",
                "Habitat is being built as an AI environment rather than a simple chatbot."
            )
        )

        list.addView(
            infoCard(
                "CORE LOOP",
                "UNDERSTAND → PLAN → ACT",
                "OBSERVE → VERIFY → CONTINUE"
            )
        )

        list.addView(
            infoCard(
                "LONG-TERM",
                "MEMORY • AGENTS • TOOLS • TASKS",
                "Android control, automation, projects and intelligent coordination."
            )
        )

        scroll.addView(list)

        root.addView(
            scroll,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )
    }

    private fun infoCard(
        title: String,
        subtitle: String,
        description: String
    ): LinearLayout {

        val card = LinearLayout(this)

        card.orientation =
            LinearLayout.VERTICAL

        card.setPadding(
            dp(17),
            dp(17),
            dp(17),
            dp(17)
        )

        val shape = GradientDrawable()

        shape.cornerRadius =
            dp(19).toFloat()

        shape.setColor(panel)

        card.background = shape

        val params = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )

        params.setMargins(
            0,
            0,
            0,
            dp(10)
        )

        card.layoutParams = params

        val titleView = TextView(this)

        titleView.text = title
        titleView.setTextColor(blue)
        titleView.textSize = 18f

        titleView.setTypeface(
            null,
            android.graphics.Typeface.BOLD
        )

        val subtitleView = TextView(this)

        subtitleView.text = subtitle
        subtitleView.setTextColor(green)
        subtitleView.textSize = 12f

        subtitleView.setPadding(
            0,
            dp(5),
            0,
            dp(8)
        )

        val descView = TextView(this)

        descView.text = description
        descView.setTextColor(muted)
        descView.textSize = 14f

        card.addView(titleView)
        card.addView(subtitleView)
        card.addView(descView)

        return card
    }

    private fun statusRow(
        label: String,
        value: String
    ): LinearLayout {

        val row = LinearLayout(this)

        row.orientation =
            LinearLayout.HORIZONTAL

        row.gravity =
            Gravity.CENTER_VERTICAL

        row.setPadding(
            dp(16),
            dp(14),
            dp(16),
            dp(14)
        )

        val shape = GradientDrawable()

        shape.cornerRadius =
            dp(15).toFloat()

        shape.setColor(panel)

        row.background = shape

        val labelView = TextView(this)

        labelView.text = label
        labelView.setTextColor(white)
        labelView.textSize = 14f

        row.addView(
            labelView,
            LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
            )
        )

        val valueView = TextView(this)

        valueView.text = value
        valueView.setTextColor(green)
        valueView.textSize = 12f

        row.addView(valueView)

        val params = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )

        params.setMargins(
            0,
            0,
            0,
            dp(7)
        )

        row.layoutParams = params

        return row
    }
}
