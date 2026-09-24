package com.habitat.core

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Build
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.*
import android.text.InputType
import android.view.ViewGroup
import android.view.animation.AlphaAnimation
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : Activity() {

    private lateinit var root: LinearLayout
    private lateinit var content: LinearLayout

    private val prefs by lazy {
        getSharedPreferences("habitat", Context.MODE_PRIVATE)
    }

    private lateinit var brainAdapter: BrainAdapter

    private val accent = Color.rgb(80, 190, 255)
    private val accent2 = Color.rgb(120, 230, 190)
    private val bg = Color.rgb(10, 12, 17)
    private val card = Color.rgb(20, 24, 32)
    private val card2 = Color.rgb(26, 31, 41)
    private val text = Color.rgb(240, 245, 250)
    private val muted = Color.rgb(145, 155, 170)
    private val inputBg = Color.rgb(28, 33, 42)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.setSoftInputMode(
            WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        )

        brainAdapter = BrainAdapter(this)

        showHome()
    }

    override fun onDestroy() {
        try {
            brainAdapter.shutdown()
        } catch (_: Exception) {
        }

        super.onDestroy()
    }

    // ------------------------------------------------------------
    // BASIC HELPERS
    // ------------------------------------------------------------

    private fun dp(value: Int): Int {
        return (value * resources.displayMetrics.density).toInt()
    }

    private fun now(): String {
        return SimpleDateFormat(
            "h:mm a",
            Locale.getDefault()
        ).format(Date())
    }

    private fun safeRoot(): LinearLayout {
        val r = LinearLayout(this)
        r.orientation = LinearLayout.VERTICAL
        r.setBackgroundColor(bg)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            r.setOnApplyWindowInsetsListener { view, insets ->

                val bars = insets.getInsets(
                    WindowInsets.Type.systemBars()
                )

                view.setPadding(
                    dp(12),
                    bars.top + dp(8),
                    dp(12),
                    bars.bottom + dp(8)
                )

                insets
            }
        }

        return r
    }

    private fun setupScreen() {
        root = safeRoot()

        setContentView(root)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            root.requestApplyInsets()
        }
    }

    // ------------------------------------------------------------
    // MAIN APP SHELL
    // ------------------------------------------------------------

    private fun shell(title: String): LinearLayout {

        val wrapper = LinearLayout(this)
        wrapper.orientation = LinearLayout.VERTICAL
        wrapper.setBackgroundColor(bg)

        // TOP HEADER
        val header = LinearLayout(this)
        header.orientation = LinearLayout.HORIZONTAL
        header.gravity = Gravity.CENTER_VERTICAL
        header.setPadding(
            dp(4),
            dp(4),
            dp(4),
            dp(8)
        )

        val titleBox = LinearLayout(this)
        titleBox.orientation = LinearLayout.VERTICAL

        val titleText = TextView(this)
        titleText.text = title
        titleText.textColor = text
        titleText.textSize = 22f
        titleText.setTypeface(null, android.graphics.Typeface.BOLD)

        val status = TextView(this)
        status.text = "AX • ONLINE"
        status.textColor = accent2
        status.textSize = 11f

        titleBox.addView(titleText)
        titleBox.addView(status)

        header.addView(
            titleBox,
            LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
            )
        )

        val menu = button("☰", accent)
        menu.setOnClickListener {
            showMore()
        }

        header.addView(
            menu,
            LinearLayout.LayoutParams(
                dp(48),
                dp(44)
            )
        )

        wrapper.addView(header)

        // TOP NAVIGATION
        val navScroll = HorizontalScrollView(this)
        navScroll.isHorizontalScrollBarEnabled = false

        val nav = LinearLayout(this)
        nav.orientation = LinearLayout.HORIZONTAL
        nav.setPadding(
            0,
            0,
            0,
            dp(10)
        )

        nav.addView(navButton("Home") {
            showHome()
        })

        nav.addView(navButton("Chat") {
            showChat()
        })

        nav.addView(navButton("Projects") {
            showProjects()
        })

        nav.addView(navButton("Brain") {
            showBrain()
        })

        nav.addView(navButton("Scenes") {
            showScenes()
        })

        nav.addView(navButton("More") {
            showMore()
        })

        navScroll.addView(nav)

        wrapper.addView(
            navScroll,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(52)
            )
        )

        return wrapper
    }

    private fun navButton(
        label: String,
        action: () -> Unit
    ): TextView {

        val b = TextView(this)

        b.text = label
        b.textColor = text
        b.textSize = 13f
        b.gravity = Gravity.CENTER
        b.setPadding(
            dp(18),
            0,
            dp(18),
            0
        )

        val drawable = GradientDrawable()
        drawable.cornerRadius = dp(20).toFloat()
        drawable.setColor(card)

        b.background = drawable

        b.setOnClickListener {
            action()
        }

        val params = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            dp(40)
        )

        params.setMargins(
            0,
            0,
            dp(8),
            0
        )

        b.layoutParams = params

        return b
    }

    private fun button(
        label: String,
        color: Int = text
    ): TextView {

        val b = TextView(this)

        b.text = label
        b.textColor = color
        b.textSize = 16f
        b.gravity = Gravity.CENTER

        val drawable = GradientDrawable()
        drawable.cornerRadius = dp(14).toFloat()
        drawable.setColor(card2)

        b.background = drawable

        return b
    }

    // ------------------------------------------------------------
    // HOME
    // ------------------------------------------------------------

    private fun showHome() {

        setupScreen()

        val shell = shell("HABITAT")

        root.addView(
            shell,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        val scroll = ScrollView(this)
        scroll.isFillViewport = true

        content = LinearLayout(this)
        content.orientation = LinearLayout.VERTICAL
        content.setPadding(
            dp(4),
            dp(4),
            dp(4),
            dp(16)
        )

        // AX STATUS CARD
        val statusCard = cardLayout()

        val statusTitle = TextView(this)
        statusTitle.text = "AX CORE"
        statusTitle.textColor = accent
        statusTitle.textSize = 18f
        statusTitle.setTypeface(null, android.graphics.Typeface.BOLD)

        val statusText = TextView(this)
        statusText.text =
            "The central intelligence layer for Habitat"
        statusText.textColor = muted
        statusText.textSize = 14f

        statusCard.addView(statusTitle)
        statusCard.addView(statusText)

        content.addView(statusCard)

        // CORE LOOP
        val loopCard = cardLayout()

        val loopTitle = TextView(this)
        loopTitle.text = "CORE LOOP"
        loopTitle.textColor = text
        loopTitle.textSize = 15f
        loopTitle.setTypeface(null, android.graphics.Typeface.BOLD)

        val loop = TextView(this)
        loop.text =
            "UNDERSTAND  →  PLAN  →  ACT\n" +
            "OBSERVE  →  VERIFY  →  CONTINUE"
        loop.textColor = accent2
        loop.textSize = 14f
        loop.setPadding(
            0,
            dp(8),
            0,
            0
        )

        loopCard.addView(loopTitle)
        loopCard.addView(loop)

        content.addView(loopCard)

        // AX PORTRAIT
        try {

            val image = ImageView(this)

            val bitmap = resources.getIdentifier(
                "ax_portrait",
                "drawable",
                packageName
            )

            if (bitmap != 0) {
                image.setImageResource(bitmap)
            }

            image.scaleType = ImageView.ScaleType.CENTER_CROP

            val imageParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(250)
            )

            imageParams.setMargins(
                0,
                dp(6),
                0,
                dp(6)
            )

            content.addView(
                image,
                imageParams
            )

        } catch (_: Exception) {
        }

        // TALK TO AX
        val talk = button(
            "CHAT WITH AX  →",
            accent
        )

        talk.textSize = 16f
        talk.setTypeface(null, android.graphics.Typeface.BOLD)

        talk.setOnClickListener {
            showChat()
        }

        content.addView(
            talk,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(52)
            )
        )

        // PROJECTS
        val projectsTitle = TextView(this)
        projectsTitle.text = "ACTIVE PROJECTS"
        projectsTitle.textColor = text
        projectsTitle.textSize = 16f
        projectsTitle.setTypeface(null, android.graphics.Typeface.BOLD)
        projectsTitle.setPadding(
            dp(4),
            dp(18),
            dp(4),
            dp(8)
        )

        content.addView(projectsTitle)

        content.addView(
            projectProgress(
                "DropPilot",
                "AI commerce engine",
                "BUILDING"
            )
        )

        content.addView(
            projectProgress(
                "Vice City Files",
                "GTA 6 media engine",
                "ACTIVE"
            )
        )

        content.addView(
            projectProgress(
                "Habitat",
                "AI operating environment",
                "BUILDING"
            )
        )

        // SYSTEMS
        val systemsTitle = TextView(this)
        systemsTitle.text = "SYSTEMS"
        systemsTitle.textColor = text
        systemsTitle.textSize = 16f
        systemsTitle.setTypeface(null, android.graphics.Typeface.BOLD)
        systemsTitle.setPadding(
            dp(4),
            dp(18),
            dp(4),
            dp(8)
        )

        content.addView(systemsTitle)

        content.addView(infoRow("Memory", "READY"))
        content.addView(infoRow("Projects", "READY"))
        content.addView(infoRow("Agents", "READY"))
        content.addView(infoRow("Tasks", "READY"))
        content.addView(infoRow("Tools", "READY"))
        content.addView(infoRow("Brain", "ONLINE"))

        scroll.addView(content)

        root.addView(
            scroll,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )
    }

    // ------------------------------------------------------------
    // CHAT
    // ------------------------------------------------------------

    private fun showChat() {

        setupScreen()

        val shell = shell("CHAT WITH AX")

        root.addView(
            shell,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        val messages = LinearLayout(this)
        messages.orientation = LinearLayout.VERTICAL
        messages.setPadding(
            dp(2),
            dp(6),
            dp(2),
            dp(12)
        )

        val scroll = ScrollView(this)
        scroll.isFillViewport = true
        scroll.addView(messages)

        root.addView(
            scroll,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )

        // INITIAL MESSAGE
        messages.addView(
            bubble(
                "AX",
                "Habitat online.\nWhat are we working on?",
                false
            )
        )

        // COMPOSER
        val composer = LinearLayout(this)
        composer.orientation = LinearLayout.HORIZONTAL
        composer.gravity = Gravity.CENTER_VERTICAL
        composer.setPadding(
            dp(2),
            dp(6),
            dp(2),
            dp(6)
        )

        val input = EditText(this)

        input.hint = "Message Ax..."
        input.hintTextColor = muted
        input.setTextColor(text)
        input.textSize = 16f

        input.inputType =
            InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_MULTI_LINE or
            InputType.TYPE_TEXT_FLAG_CAP_SENTENCES

        input.gravity = Gravity.TOP or Gravity.START

        input.setPadding(
            dp(16),
            dp(12),
            dp(12),
            dp(12)
        )

        val inputDrawable = GradientDrawable()
        inputDrawable.cornerRadius = dp(22).toFloat()
        inputDrawable.setColor(inputBg)

        input.background = inputDrawable

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
        send.textColor = Color.WHITE
        send.textSize = 24f
        send.gravity = Gravity.CENTER
        send.setTypeface(null, android.graphics.Typeface.BOLD)

        val sendDrawable = GradientDrawable()
        sendDrawable.cornerRadius = dp(29).toFloat()
        sendDrawable.setColor(accent.toArgb())

        send.background = sendDrawable

        val sendParams = LinearLayout.LayoutParams(
            dp(54),
            dp(54)
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

        root.addView(
            composer,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(70)
            )
        )

        fun sendMessage() {

            val message = input.text.toString().trim()

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

            scroll.post {
                scroll.fullScroll(View.FOCUS_DOWN)
            }

            messages.addView(
                bubble(
                    "AX",
                    "Thinking…",
                    false
                )
            )

            scroll.post {
                scroll.fullScroll(View.FOCUS_DOWN)
            }

            brainAdapter.send(
                message,
                object : BrainAdapter.Callback {

                    override fun onStateChanged(
                        state: BrainAdapter.State
                    ) {
                    }

                    override fun onResponse(
                        response: String
                    ) {

                        runOnUiThread {

                            if (messages.childCount > 0) {
                                messages.removeViewAt(
                                    messages.childCount - 1
                                )
                            }

                            messages.addView(
                                bubble(
                                    "AX",
                                    response,
                                    false
                                )
                            )

                            scroll.post {
                                scroll.fullScroll(
                                    View.FOCUS_DOWN
                                )
                            }
                        }
                    }

                    override fun onError(
                        error: String
                    ) {

                        runOnUiThread {

                            if (messages.childCount > 0) {
                                messages.removeViewAt(
                                    messages.childCount - 1
                                )
                            }

                            messages.addView(
                                bubble(
                                    "AX",
                                    "I couldn't complete that request yet.\n\n$error",
                                    false
                                )
                            )

                            scroll.post {
                                scroll.fullScroll(
                                    View.FOCUS_DOWN
                                )
                            }
                        }
                    }
                }
            )
        }

        send.setOnClickListener {
            sendMessage()
        }

        input.setOnEditorActionListener { _, _, _ ->
            false
        }

        input.requestFocus()

        // Don't automatically force the keyboard open.
        val imm = getSystemService(
            Context.INPUT_METHOD_SERVICE
        ) as InputMethodManager

        imm.hideSoftInputFromWindow(
            input.windowToken,
            0
        )
    }

    // ------------------------------------------------------------
    // PROJECTS
    // ------------------------------------------------------------

    private fun showProjects() {

        setupScreen()

        val shell = shell("PROJECTS")

        root.addView(
            shell,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        val scroll = ScrollView(this)

        val list = LinearLayout(this)
        list.orientation = LinearLayout.VERTICAL
        list.setPadding(
            dp(4),
            dp(4),
            dp(4),
            dp(20)
        )

        list.addView(
            projectCard(
                "DropPilot AI",
                "AI-powered TikTok Shop commerce system",
                "RESEARCH → SCORE → VERIFY → SELECT → LIST → MONITOR"
            )
        )

        list.addView(
            projectCard(
                "Vice City Files",
                "GTA 6 content and media engine",
                "RESEARCH → SCRIPT → CREATE → PUBLISH → ANALYZE"
            )
        )

        list.addView(
            projectCard(
                "Habitat",
                "The AI environment that coordinates everything",
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

    private fun projectCard(
        name: String,
        description: String,
        flow: String
    ): LinearLayout {

        val c = cardLayout()

        val title = TextView(this)
        title.text = name
        title.textColor = accent
        title.textSize = 19f
        title.setTypeface(null, android.graphics.Typeface.BOLD)

        val desc = TextView(this)
        desc.text = description
        desc.textColor = text
        desc.textSize = 14f
        desc.setPadding(
            0,
            dp(6),
            0,
            dp(10)
        )

        val flowText = TextView(this)
        flowText.text = flow
        flowText.textColor = accent2
        flowText.textSize = 12f

        c.addView(title)
        c.addView(desc)
        c.addView(flowText)

        return c
    }

    private fun projectProgress(
        name: String,
        description: String,
        state: String
    ): LinearLayout {

        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL

        row.setPadding(
            dp(14),
            dp(12),
            dp(14),
            dp(12)
        )

        val drawable = GradientDrawable()
        drawable.cornerRadius = dp(14).toFloat()
        drawable.setColor(card)

        row.background = drawable

        val info = LinearLayout(this)
        info.orientation = LinearLayout.VERTICAL

        val title = TextView(this)
        title.text = name
        title.textColor = text
        title.textSize = 15f
        title.setTypeface(null, android.graphics.Typeface.BOLD)

        val desc = TextView(this)
        desc.text = description
        desc.textColor = muted
        desc.textSize = 12f

        info.addView(title)
        info.addView(desc)

        row.addView(
            info,
            LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
            )
        )

        val stateText = TextView(this)
        stateText.text = state
        stateText.textColor = accent2
        stateText.textSize = 11f

        row.addView(stateText)

        val params = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )

        params.setMargins(
            0,
            0,
            0,
            dp(8)
        )

        row.layoutParams = params

        return row
    }

    // ------------------------------------------------------------
    // BRAIN
    // ------------------------------------------------------------

    private fun showBrain() {

        setupScreen()

        val shell = shell("AX BRAIN")

        root.addView(
            shell,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        val scroll = ScrollView(this)

        val list = LinearLayout(this)
        list.orientation = LinearLayout.VERTICAL
        list.setPadding(
            dp(4),
            dp(4),
            dp(4),
            dp(20)
        )

        val status = cardLayout()

        val title = TextView(this)
        title.text = "BRAIN STATUS"
        title.textColor = accent
        title.textSize = 18f
        title.setTypeface(null, android.graphics.Typeface.BOLD)

        val online = TextView(this)
        online.text = "ONLINE"
        online.textColor = accent2
        online.textSize = 16f
        online.setPadding(
            0,
            dp(8),
            0,
            dp(8)
        )

        val endpoint = TextView(this)
        endpoint.text =
            "Habitat Core → Ax Brain → OpenRouter"
        endpoint.textColor = muted
        endpoint.textSize = 13f

        status.addView(title)
        status.addView(online)
        status.addView(endpoint)

        list.addView(status)

        list.addView(
            infoRow(
                "Brain Adapter",
                "CONNECTED"
            )
        )

        list.addView(
            infoRow(
                "Conversation Memory",
                "READY"
            )
        )

        list.addView(
            infoRow(
                "Reasoning",
                "READY"
            )
        )

        list.addView(
            infoRow(
                "Agent Coordination",
                "READY"
            )
        )

        list.addView(
            infoRow(
                "Tool Layer",
                "READY"
            )
        )

        val clear = button(
            "CLEAR LOCAL CONVERSATION MEMORY",
            Color.rgb(255, 150, 150)
        )

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
                dp(52)
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

    // ------------------------------------------------------------
    // SCENES
    // ------------------------------------------------------------

    private fun showScenes() {

        setupScreen()

        val shell = shell("SCENES")

        root.addView(
            shell,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        val scroll = ScrollView(this)

        val grid = LinearLayout(this)
        grid.orientation = LinearLayout.VERTICAL
        grid.setPadding(
            dp(4),
            dp(4),
            dp(4),
            dp(20)
        )

        grid.addView(
            sceneIcon(
                "⌂",
                "COMMAND CENTER",
                "Main Habitat control environment"
            )
        )

        grid.addView(
            sceneIcon(
                "◉",
                "CHAT WITH AX",
                "Direct conversation with the core"
            )
        )

        grid.addView(
            sceneIcon(
                "◆",
                "PROJECT CONTROL",
                "Manage active Habitat projects"
            )
        )

        grid.addView(
            sceneIcon(
                "⚙",
                "SYSTEM CONTROL",
                "Tools, tasks, agents and automation"
            )
        )

        scroll.addView(grid)

        root.addView(
            scroll,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )
    }

    private fun sceneIcon(
        icon: String,
        titleText: String,
        description: String
    ): LinearLayout {

        val c = cardLayout()

        val iconView = TextView(this)
        iconView.text = icon
        iconView.textColor = accent
        iconView.textSize = 28f

        val title = TextView(this)
        title.text = titleText
        title.textColor = text
        title.textSize = 17f
        title.setTypeface(null, android.graphics.Typeface.BOLD)

        val desc = TextView(this)
        desc.text = description
        desc.textColor = muted
        desc.textSize = 13f

        c.addView(iconView)
        c.addView(title)
        c.addView(desc)

        return c
    }

    // ------------------------------------------------------------
    // MORE
    // ------------------------------------------------------------

    private fun showMore() {

        setupScreen()

        val shell = shell("HABITAT")

        root.addView(
            shell,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        val scroll = ScrollView(this)

        val list = LinearLayout(this)
        list.orientation = LinearLayout.VERTICAL
        list.setPadding(
            dp(4),
            dp(4),
            dp(4),
            dp(20)
        )

        val about = cardLayout()

        val title = TextView(this)
        title.text = "HABITAT v0.2.2"
        title.textColor = accent
        title.textSize = 20f
        title.setTypeface(null, android.graphics.Typeface.BOLD)

        val description = TextView(this)
        description.text =
            "An AI environment built around Ax.\n\n" +
            "Habitat is designed to become more than a chat interface. " +
            "The long-term system combines memory, reasoning, projects, " +
            "agents, tools, tasks, automation and Android interaction."
        description.textColor = text
        description.textSize = 14f
        description.setPadding(
            0,
            dp(10),
            0,
            0
        )

        about.addView(title)
        about.addView(description)

        list.addView(about)

        list.addView(
            infoRow(
                "Version",
                "v0.2.2"
            )
        )

        list.addView(
            infoRow(
                "Core",
                "AX"
            )
        )

        list.addView(
            infoRow(
                "Environment",
                "HABITAT"
            )
        )

        list.addView(
            infoRow(
                "Backend",
                "ONLINE"
            )
        )

        val chat = button(
            "RETURN TO AX  →",
            accent
        )

        chat.setOnClickListener {
            showChat()
        }

        list.addView(
            chat,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(52)
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

    // ------------------------------------------------------------
    // UI COMPONENTS
    // ------------------------------------------------------------

    private fun cardLayout(): LinearLayout {

        val c = LinearLayout(this)

        c.orientation = LinearLayout.VERTICAL

        c.setPadding(
            dp(16),
            dp(16),
            dp(16),
            dp(16)
        )

        val drawable = GradientDrawable()
        drawable.cornerRadius = dp(18).toFloat()
        drawable.setColor(card)

        c.background = drawable

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

        c.layoutParams = params

        return c
    }

    private fun infoRow(
        label: String,
        value: String
    ): LinearLayout {

        val row = LinearLayout(this)

        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL

        row.setPadding(
            dp(14),
            dp(12),
            dp(14),
            dp(12)
        )

        val drawable = GradientDrawable()
        drawable.cornerRadius = dp(14).toFloat()
        drawable.setColor(card)

        row.background = drawable

        val l = TextView(this)
        l.text = label
        l.textColor = text
        l.textSize = 14f

        row.addView(
            l,
            LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
            )
        )

        val v = TextView(this)
        v.text = value
        v.textColor = accent2
        v.textSize = 12f

        row.addView(v)

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

    private fun bubble(
        speaker: String,
        message: String,
        user: Boolean
    ): LinearLayout {

        val wrapper = LinearLayout(this)

        wrapper.orientation = LinearLayout.VERTICAL

        wrapper.gravity =
            if (user) Gravity.END else Gravity.START

        wrapper.setPadding(
            dp(4),
            dp(5),
            dp(4),
            dp(5)
        )

        val label = TextView(this)
        label.text = "$speaker  •  ${now()}"
        label.textColor =
            if (user) accent else accent2
        label.textSize = 10f

        val textView = TextView(this)
        textView.text = message
        textView.textColor = text
        textView.textSize = 15f

        textView.setPadding(
            dp(15),
            dp(12),
            dp(15),
            dp(12)
        )

        val drawable = GradientDrawable()

        drawable.cornerRadius = dp(18).toFloat()

        drawable.setColor(
            if (user) {
                Color.rgb(31, 55, 72)
            } else {
                card
            }
        )

        textView.background = drawable

        val maxWidth =
            (resources.displayMetrics.widthPixels * 0.84f).toInt()

        wrapper.addView(label)

        wrapper.addView(
            textView,
            LinearLayout.LayoutParams(
                maxWidth,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        return wrapper
    }

    private fun animateAx(view: View) {

        val animation = AlphaAnimation(
            0.65f,
            1.0f
        )

        animation.duration = 900
        animation.repeatMode =
            AlphaAnimation.REVERSE
        animation.repeatCount =
            AlphaAnimation.INFINITE

        view.startAnimation(animation)
    }

    private fun Int.toArgb(): Int {
        return this
    }
}
