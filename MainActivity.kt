package com.habitat.core

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Space
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {

    private lateinit var root: LinearLayout
    private lateinit var brainAdapter: BrainAdapter

    private val bg = Color.rgb(10, 12, 16)
    private val panel = Color.rgb(17, 20, 26)
    private val panel2 = Color.rgb(22, 26, 33)
    private val inputBg = Color.rgb(27, 31, 39)
    private val white = Color.rgb(242, 245, 248)
    private val muted = Color.rgb(145, 153, 166)
    private val blue = Color.rgb(72, 145, 255)
    private val green = Color.rgb(55, 210, 125)

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
        brainAdapter.shutdown()
        super.onDestroy()
    }

    private fun createRoot(): LinearLayout {
        root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.setBackgroundColor(bg)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            root.setOnApplyWindowInsetsListener { view, insets ->

                val bars = insets.getInsets(
                    WindowInsets.Type.systemBars()
                )

                view.setPadding(
                    0,
                                       bars.top,
                    0,
                    bars.bottom
                )

                insets
            }
        }

        return root
    }

    private fun topBar(
        title: String = "HABITAT",
        subtitle: String = "AX CORE"
    ): LinearLayout {

        val bar = LinearLayout(this)

        bar.orientation = LinearLayout.HORIZONTAL
        bar.gravity = Gravity.CENTER_VERTICAL
        bar.setPadding(16, 12, 16, 12)
        bar.setBackgroundColor(panel)

        val menu = TextView(this)

        menu.text = "☰"
        menu.textSize = 27f
        menu.setTextColor(white)
        menu.gravity = Gravity.CENTER
        menu.setPadding(4, 0, 18, 0)

        menu.setOnClickListener {
            showMenu()
        }

        bar.addView(
            menu,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        val titles = LinearLayout(this)

        titles.orientation = LinearLayout.VERTICAL

        val titleView = TextView(this)

        titleView.text = title
        titleView.textSize = 18f
        titleView.setTextColor(white)
        titleView.setTypeface(null, Typeface.BOLD)

        val subtitleView = TextView(this)

        subtitleView.text = subtitle
        subtitleView.textSize = 11f
        subtitleView.setTextColor(muted)

        titles.addView(titleView)
        titles.addView(subtitleView)

        bar.addView(
            titles,
            LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
            )
        )

        val dot = TextView(this)

        dot.text = "●"
        dot.textSize = 14f
        dot.setTextColor(green)
        dot.gravity = Gravity.CENTER

        bar.addView(
            dot,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        return bar
    }

    private fun showChatHome() {

        root = createRoot()

        root.addView(
            topBar("HABITAT", "AX CORE"),
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        val scroll = ScrollView(this)

        scroll.isFillViewport = true

        val chat = LinearLayout(this)

        chat.orientation = LinearLayout.VERTICAL
        chat.setPadding(18, 18, 18, 18)

        val welcome = TextView(this)

        welcome.text = "Habitat"
        welcome.textSize = 30f
        welcome.setTextColor(white)
        welcome.setTypeface(null, Typeface.BOLD)

        chat.addView(welcome)

        val intro = TextView(this)

        intro.text =
            "Your AI environment. Talk to Ax, manage projects, and build the system."

        intro.textSize = 14f
        intro.setTextColor(muted)
        intro.setPadding(0, 4, 0, 18)

        chat.addView(intro)

        chat.addView(
            bubble(
                "Ax",
                "Habitat online.\n\nWhat are we working on?"
            )
        )

        val spacer = Space(this)

        chat.addView(
            spacer,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )

        scroll.addView(chat)

        root.addView(
            scroll,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )

        val composer = LinearLayout(this)

        composer.orientation = LinearLayout.HORIZONTAL
        composer.gravity = Gravity.CENTER_VERTICAL
        composer.setPadding(12, 10, 12, 10)
        composer.setBackgroundColor(panel)

        val input = EditText(this)

        input.hint = "Message Ax..."
        input.setHintTextColor(muted)
        input.setTextColor(white)
        input.textSize = 16f
        input.setSingleLine(false)
        input.maxLines = 4
        input.setPadding(16, 12, 16, 12)

        input.background = roundedBackground(
            inputBg,
            22f
        )

        composer.addView(
            input,
            LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
            ).apply {
                setMargins(0, 0, 8, 0)
            }
        )

        val send = Button(this)

        send.text = "➤"
        send.textSize = 20f
        send.setTextColor(Color.WHITE)
        send.background = roundedBackground(
            blue,
            22f
        )

        send.minWidth = 52
        send.minHeight = 52

        composer.addView(
            send,
            LinearLayout.LayoutParams(
                52,
                52
            )
        )

        send.setOnClickListener {

            val message = input.text.toString().trim()

            if (message.isEmpty()) {
                return@setOnClickListener
            }

            input.isEnabled = false
            send.isEnabled = false

            chat.addView(
                bubble(
                    "You",
                    message
                )
            )

            input.setText("")

            scroll.post {
                scroll.fullScroll(View.FOCUS_DOWN)
            }

            brainAdapter.send(message) { result ->

                runOnUiThread {

                    when (result.state) {

                        BrainAdapter.State.CONNECTED -> {

                            input.isEnabled = true
                            send.isEnabled = true

                            chat.addView(
                                bubble(
                                    "Ax",
                                    result.text
                                )
                            )

                            scroll.post {
                                scroll.fullScroll(View.FOCUS_DOWN)
                            }
                        }

                        BrainAdapter.State.ERROR -> {

                            input.isEnabled = true
                            send.isEnabled = true

                            val errorText =
                                if (result.detail.isNotBlank()) {
                                    "Brain error:\n${result.detail}"
                                } else {
                                    "Brain error."
                                }

                            chat.addView(
                                bubble(
                                    "Ax",
                                    errorText
                                )
                            )

                            scroll.post {
                                scroll.fullScroll(View.FOCUS_DOWN)
                            }

                            Toast.makeText(
                                this,
                                result.detail.ifBlank {
                                    "Brain error"
                                },
                                Toast.LENGTH_LONG
                            ).show()
                        }

                        BrainAdapter.State.CONNECTING -> {
                        }

                        BrainAdapter.State.DISCONNECTED -> {

                            input.isEnabled = true
                            send.isEnabled = true

                            chat.addView(
                                bubble(
                                    "Ax",
                                    "Brain disconnected."
                                )
                            )
                        }
                    }
                }
            }
        }

        root.addView(
            composer,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        setContentView(root)
    }

    private fun showMenu() {

        val dialog = Dialog(this)

        val menuRoot = LinearLayout(this)

        menuRoot.orientation = LinearLayout.VERTICAL
        menuRoot.setPadding(20, 20, 20, 20)
        menuRoot.setBackgroundColor(panel)

        val title = TextView(this)

        title.text = "HABITAT"
        title.textSize = 22f
        title.setTextColor(white)
        title.setTypeface(null, Typeface.BOLD)
        title.setPadding(8, 8, 8, 18)

        menuRoot.addView(title)

        addMenuItem(menuRoot, "Chat with Ax") {
            dialog.dismiss()
            showChatHome()
        }

        addMenuItem(menuRoot, "Projects") {
            dialog.dismiss()
            showProjects()
        }

        addMenuItem(menuRoot, "Brain") {
            dialog.dismiss()
            showBrain()
        }

        addMenuItem(menuRoot, "Scenes") {
            dialog.dismiss()
            showScenes()
        }

        addMenuItem(menuRoot, "Systems") {
            dialog.dismiss()
            showSystems()
        }

        addMenuItem(menuRoot, "About Habitat") {
            dialog.dismiss()
            showAbout()
        }

        dialog.setContentView(menuRoot)

        dialog.window?.setBackgroundDrawable(
            roundedBackground(panel, 20f)
        )

        dialog.show()

        dialog.window?.setLayout(
            (resources.displayMetrics.widthPixels * 0.88).toInt(),
            WindowManager.LayoutParams.WRAP_CONTENT
        )
    }

    private fun addMenuItem(
        parent: LinearLayout,
        text: String,
        action: () -> Unit
    ) {

        val item = TextView(this)

        item.text = text
        item.textSize = 17f
        item.setTextColor(white)
        item.gravity = Gravity.CENTER_VERTICAL
        item.setPadding(18, 18, 18, 18)

        item.background = roundedBackground(
            panel2,
            14f
        )

        item.setOnClickListener {
            action()
        }

        val params = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )

        params.setMargins(0, 0, 0, 10)

        parent.addView(item, params)
    }

    private fun showProjects() {

        val r = createRoot()

        r.addView(
            topBar("PROJECTS", "HABITAT WORKSPACES")
        )

        val content = LinearLayout(this)

        content.orientation = LinearLayout.VERTICAL
        content.setPadding(18, 20, 18, 20)

        content.addView(
            infoCard(
                "DropPilot AI",
                "TikTok Shop automation project.\nStatus: ACTIVE"
            )
        )

        content.addView(
            infoCard(
                "Vice City Files",
                "GTA 6 content system.\nStatus: ACTIVE"
            )
        )

        content.addView(
            infoCard(
                "Habitat",
                "The AI environment itself.\nStatus: BUILDING"
            )
        )

        r.addView(
            content,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )

        setContentView(r)
    }

    private fun showBrain() {

        val r = createRoot()

        r.addView(
            topBar("BRAIN", "AX INTELLIGENCE")
        )

        val content = LinearLayout(this)

        content.orientation = LinearLayout.VERTICAL
        content.setPadding(18, 20, 18, 20)

        content.addView(
            infoCard(
                "Brain Status",
                "Connected to Habitat's remote AI brain."
            )
        )

        content.addView(
            statusRow(
                "Remote Brain",
                "ONLINE",
                green
            )
        )

        content.addView(
            statusRow(
                "Memory",
                "LOCAL",
                green
            )
        )

        content.addView(
            statusRow(
                "Conversation History",
                "ACTIVE",
                green
            )
        )

        val clear = Button(this)

        clear.text = "Clear Local Memory"
        clear.setTextColor(white)

        clear.background = roundedBackground(
            panel2,
            14f
        )

        clear.setOnClickListener {

            brainAdapter.clearMemory()

            Toast.makeText(
                this,
                "Local memory cleared",
                Toast.LENGTH_SHORT
            ).show()
        }

        content.addView(
            clear,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                54
            ).apply {
                setMargins(0, 20, 0, 0)
            }
        )

        r.addView(
            content,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )

        setContentView(r)
    }

    private fun showScenes() {

        val r = createRoot()

        r.addView(
            topBar("SCENES", "HABITAT ENVIRONMENTS")
        )

        val content = LinearLayout(this)

        content.orientation = LinearLayout.VERTICAL
        content.setPadding(18, 20, 18, 20)

        content.addView(
            infoCard(
                "Ax Workspace",
                "Primary Habitat workspace scene."
            )
        )

        content.addView(
            infoCard(
                "Desk Scene",
                "Future animated Audrey/Ax environment."
            )
        )

        content.addView(
            infoCard(
                "Command Center",
                "Future full Habitat control environment."
            )
        )

        r.addView(
            content,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )

        setContentView(r)
    }

    private fun showSystems() {

        val r = createRoot()

        r.addView(
            topBar("SYSTEMS", "HABITAT CORE")
        )

        val content = LinearLayout(this)

        content.orientation = LinearLayout.VERTICAL
        content.setPadding(18, 20, 18, 20)

        content.addView(
            statusRow(
                "Memory",
                "READY",
                green
            )
        )

        content.addView(
            statusRow(
                "Projects",
                "READY",
                green
            )
        )

        content.addView(
            statusRow(
                "Agents",
                "READY",
                green
            )
        )

        content.addView(
            statusRow(
                "Tasks",
                "READY",
                green
            )
        )

        content.addView(
            statusRow(
                "Tools",
                "READY",
                green
            )
        )

        content.addView(
            statusRow(
                "Brain",
                "ONLINE",
                green
            )
        )

        content.addView(
            infoCard(
                "Core Loop",
                "UNDERSTAND → PLAN → ACT → OBSERVE → VERIFY → CONTINUE"
            )
        )

        r.addView(
            content,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )

        setContentView(r)
    }

    private fun showAbout() {

        val r = createRoot()

        r.addView(
            topBar("ABOUT", "HABITAT v0.2.2")
        )

        val content = LinearLayout(this)

        content.orientation = LinearLayout.VERTICAL
        content.setPadding(18, 20, 18, 20)

        content.addView(
            infoCard(
                "Habitat",
                "An AI environment being built around Ax."
            )
        )

        content.addView(
            infoCard(
                "Current Version",
                "v0.2.2 — Ax Edition"
            )
        )

        content.addView(
            infoCard(
                "Mission",
                "Build a persistent AI environment capable of memory, reasoning, projects, agents, tools, automation, and eventually Android control."
            )
        )

        content.addView(
            infoCard(
                "Core Principle",
                "Never pretend an action happened unless the system actually completed it."
            )
        )

        r.addView(
            content,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )

        setContentView(r)
    }

    private fun bubble(
        speaker: String,
        message: String
    ): LinearLayout {

        val container = LinearLayout(this)

        container.orientation = LinearLayout.VERTICAL

        val label = TextView(this)

        label.text = speaker
        label.textSize = 12f
        label.setTextColor(
            if (speaker == "Ax") blue else muted
        )
        label.setTypeface(null, Typeface.BOLD)

        val text = TextView(this)

        text.text = message
        text.textSize = 16f
        text.setTextColor(white)
        text.setPadding(16, 14, 16, 14)

        text.background = roundedBackground(
            if (speaker == "Ax") panel2 else inputBg,
            16f
        )

        container.addView(label)

        container.addView(
            text,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 4, 0, 16)
            }
        )

        return container
    }

    private fun infoCard(
        title: String,
        description: String
    ): LinearLayout {

        val card = LinearLayout(this)

        card.orientation = LinearLayout.VERTICAL
        card.setPadding(18, 16, 18, 16)

        card.background = roundedBackground(
            panel2,
            16f
        )

        val titleView = TextView(this)

        titleView.text = title
        titleView.textSize = 17f
        titleView.setTextColor(white)
        titleView.setTypeface(null, Typeface.BOLD)

        val descriptionView = TextView(this)

        descriptionView.text = description
        descriptionView.textSize = 14f
        descriptionView.setTextColor(muted)
        descriptionView.setPadding(0, 6, 0, 0)

        card.addView(titleView)
        card.addView(descriptionView)

        val params = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )

        params.setMargins(0, 0, 0, 12)

        card.layoutParams = params

        return card
    }

    private fun statusRow(
        name: String,
        status: String,
        color: Int
    ): LinearLayout {

        val row = LinearLayout(this)

        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.setPadding(16, 15, 16, 15)

        row.background = roundedBackground(
            panel2,
            14f
        )

        val nameView = TextView(this)

        nameView.text = name
        nameView.textSize = 16f
        nameView.setTextColor(white)

        row.addView(
            nameView,
            LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
            )
        )

        val statusView = TextView(this)

        statusView.text = "● $status"
        statusView.textSize = 13f
        statusView.setTextColor(color)

        row.addView(statusView)

        val params = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )

        params.setMargins(0, 0, 0, 10)

        row.layoutParams = params

        return row
    }

    private fun roundedBackground(
        color: Int,
        radius: Float
    ): GradientDrawable {

        val drawable = GradientDrawable()

        drawable.setColor(color)
        drawable.cornerRadius = radius

        return drawable
    }
}
