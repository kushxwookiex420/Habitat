package com.habitat.core

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.view.animation.AlphaAnimation
import android.widget.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : Activity() {

    private lateinit var content: LinearLayout
    private lateinit var status: TextView
    private lateinit var axImage: ImageView

    private val prefs by lazy {
        getSharedPreferences("habitat", Context.MODE_PRIVATE)
    }

    private val brainAdapter by lazy {
        BrainAdapter(this)
    }

    private val accent = Color.rgb(82, 188, 255)
    private val bg = Color.rgb(7, 9, 15)
    private val card = Color.rgb(17, 21, 31)
    private val textColor = Color.WHITE
    private val muted = Color.rgb(150, 162, 180)
    private val inputBg = Color.rgb(20, 25, 36)

    private fun dp(v: Int): Int =
        (v * resources.displayMetrics.density).toInt()

    private fun now(): String =
        SimpleDateFormat("h:mm a", Locale.US).format(Date())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.setSoftInputMode(
            WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        )

        showHome()
    }

    override fun onDestroy() {
        brainAdapter.shutdown()
        super.onDestroy()
    }

    /*
     * =========================================================
     * HABITAT BASE LAYOUT
     * =========================================================
     *
     * Automatically adds Samsung's bottom navigation/gesture
     * inset so Habitat controls remain above the system area.
     */

    private fun base(): LinearLayout =
        LinearLayout(this).apply {

            orientation = LinearLayout.VERTICAL

            setBackgroundColor(bg)

            setPadding(
                dp(14),
                dp(12),
                dp(14),
                dp(10)
            )

            setOnApplyWindowInsetsListener { view, insets ->

                val navigationBottom =
                    insets.getInsets(
                        WindowInsets.Type.navigationBars()
                    ).bottom

                view.setPadding(
                    dp(14),
                    dp(12),
                    dp(14),
                    dp(10) + navigationBottom
                )

                insets
            }
        }

    private fun label(
        value: String,
        size: Float = 14f,
        color: Int = textColor
    ) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(color)
    }

    private fun button(
        value: String,
        onClick: () -> Unit
    ) = Button(this).apply {

        text = value
        textSize = 12f
        setTextColor(textColor)

        setOnClickListener {
            onClick()
        }

        background = rounded(
            Color.rgb(27, 34, 48),
            dp(12)
        )

        minHeight = dp(44)
    }

    private fun rounded(
        color: Int,
        radius: Int
    ): GradientDrawable =
        GradientDrawable().apply {

            setColor(color)

            cornerRadius =
                radius.toFloat()

            setStroke(
                dp(1),
                Color.rgb(42, 55, 75)
            )
        }

    private fun header(
        title: String,
        subtitle: String
    ): LinearLayout =
        LinearLayout(this).apply {

            orientation =
                LinearLayout.VERTICAL

            addView(
                label(title, 27f)
            )

            addView(
                label(
                    subtitle,
                    12f,
                    muted
                ),
                LinearLayout.LayoutParams(
                    -1,
                    -2
                ).apply {
                    topMargin = dp(2)
                }
            )
        }

    /*
     * =========================================================
     * NAVIGATION
     * =========================================================
     */

    private fun install(root: LinearLayout) {

        content = root

        val nav =
            LinearLayout(this).apply {

                orientation =
                    LinearLayout.HORIZONTAL

                gravity =
                    Gravity.CENTER
            }

        listOf(
            "Home",
            "Projects",
            "Brain",
            "Scenes",
            "More"
        ).forEach { item ->

            nav.addView(
                button(item) {

                    when (item) {

                        "Home" ->
                            showHome()

                        "Projects" ->
                            showProjects()

                        "Brain" ->
                            showBrain()

                        "Scenes" ->
                            showScenes()

                        else ->
                            showMore()
                    }
                },
                LinearLayout.LayoutParams(
                    0,
                    dp(52),
                    1f
                )
            )
        }

        root.addView(
            nav,
            LinearLayout.LayoutParams(
                -1,
                dp(56)
            )
        )

        setContentView(root)

        /*
         * Re-apply insets after the view enters the window.
         */
        root.requestApplyInsets()
    }

    private fun setStatus(
        value: String,
        color: Int = muted
    ) {

        if (::status.isInitialized) {

            status.text = value
            status.setTextColor(color)
        }
    }

    /*
     * =========================================================
     * HOME
     * =========================================================
     */

    private fun showHome() {

        val root = base()

        root.addView(
            header(
                "HABITAT",
                "Your AI companion • Your mission • Your habitat"
            ),
            LinearLayout.LayoutParams(
                -1,
                -2
            )
        )

        status = label(
            "● BRAIN ADAPTER: ${
                if (brainAdapter.endpoint().isBlank())
                    "NOT CONNECTED"
                else
                    "ENDPOINT READY"
            }",
            13f,
            if (brainAdapter.endpoint().isBlank())
                Color.rgb(255, 190, 90)
            else
                Color.rgb(120, 220, 150)
        )

        root.addView(
            status,
            LinearLayout.LayoutParams(
                -1,
                -2
            ).apply {
                topMargin = dp(7)
            }
        )

        val art =
            FrameLayout(this).apply {

                background =
                    rounded(
                        Color.rgb(12, 15, 23),
                        dp(18)
                    )
            }

        axImage =
            ImageView(this).apply {

                setImageResource(
                    R.drawable.ax_portrait
                )

                scaleType =
                    ImageView.ScaleType.CENTER_CROP

                alpha = .98f

                contentDescription =
                    "Ax companion"
            }

        art.addView(
            axImage,
            FrameLayout.LayoutParams(
                -1,
                dp(310)
            )
        )

        val overlay =
            label(
                "AX  •  ONLINE\n\"I'm here. What's the mission?\"",
                16f
            )

        overlay.setPadding(
            dp(14),
            dp(12),
            dp(14),
            dp(12)
        )

        overlay.background =
            rounded(
                Color.argb(
                    215,
                    7,
                    9,
                    15
                ),
                dp(14)
            )

        val op =
            FrameLayout.LayoutParams(
                -1,
                dp(76),
                Gravity.BOTTOM
            )

        op.setMargins(
            dp(10),
            0,
            dp(10),
            dp(10)
        )

        art.addView(
            overlay,
            op
        )

        root.addView(
            art,
            LinearLayout.LayoutParams(
                -1,
                dp(310)
            ).apply {
                topMargin = dp(12)
            }
        )

        val row =
            LinearLayout(this).apply {
                orientation =
                    LinearLayout.HORIZONTAL
            }

        row.addView(
            button("TALK TO AX") {
                showChat()
            },
            LinearLayout.LayoutParams(
                0,
                dp(52),
                1f
            )
        )

        row.addView(
            button("SCENES") {
                showScenes()
            },
            LinearLayout.LayoutParams(
                0,
                dp(52),
                1f
            ).apply {
                leftMargin = dp(8)
            }
        )

        root.addView(
            row,
            LinearLayout.LayoutParams(
                -1,
                dp(60)
            ).apply {
                topMargin = dp(8)
            }
        )

        val grid =
            LinearLayout(this).apply {

                orientation =
                    LinearLayout.VERTICAL
            }

        grid.addView(
            infoRow(
                "DropPilot AI",
                prefs.getInt(
                    "drop",
                    67
                ).toString() + "%",
                "TikTok Shop / Shopify"
            )
        )

        grid.addView(
            infoRow(
                "GTA 6 Channel",
                "42%",
                "Video / editing / upload"
            )
        )

        grid.addView(
            infoRow(
                "Habitat Development",
                "25%",
                "UI / brain / testing"
            )
        )

        root.addView(
            grid,
            LinearLayout.LayoutParams(
                -1,
                0,
                1f
            ).apply {
                topMargin = dp(8)
            }
        )

        install(root)
    }

    private fun infoRow(
        title: String,
        progress: String,
        sub: String
    ): View =
        LinearLayout(this).apply {

            orientation =
                LinearLayout.HORIZONTAL

            gravity =
                Gravity.CENTER_VERTICAL

            background =
                rounded(
                    card,
                    dp(14)
                )

            setPadding(
                dp(12),
                dp(9),
                dp(12),
                dp(9)
            )

            addView(
                LinearLayout(
                    this@MainActivity
                ).apply {

                    orientation =
                        LinearLayout.VERTICAL

                    addView(
                        label(
                            title,
                            14f
                        )
                    )

                    addView(
                        label(
                            sub,
                            11f,
                            muted
                        )
                    )

                },
                LinearLayout.LayoutParams(
                    0,
                    -2,
                    1f
                )
            )

            addView(
                label(
                    progress,
                    16f,
                    accent
                )
            )

            layoutParams =
                LinearLayout.LayoutParams(
                    -1,
                    dp(66)
                ).apply {
                    bottomMargin = dp(7)
                }
        }

    /*
     * =========================================================
     * CHAT
     * =========================================================
     */

    private fun showChat() {

        val root = base()

        root.addView(
            header(
                "Chat",
                "Direct connection to Ax's brain"
            )
        )

        status =
            label(
                "● BRAIN ADAPTER: READY",
                12f,
                Color.rgb(
                    120,
                    220,
                    150
                )
            )

        root.addView(
            status,
            LinearLayout.LayoutParams(
                -1,
                -2
            ).apply {
                topMargin = dp(6)
            }
        )

        val scroll =
            ScrollView(this).apply {
                isFillViewport = true
            }

        val log =
            LinearLayout(this).apply {

                orientation =
                    LinearLayout.VERTICAL

                setPadding(
                    0,
                    dp(10),
                    0,
                    dp(10)
                )
            }

        log.addView(
            bubble(
                "Ax",
                "Hey. I'm here. What's the mission?",
                false
            )
        )

        scroll.addView(log)

        root.addView(
            scroll,
            LinearLayout.LayoutParams(
                -1,
                0,
                1f
            )
        )

        /*
         * =====================================================
         * LARGE AX COMMAND CONSOLE
         * =====================================================
         */

        val input =
            EditText(this).apply {

                hint =
                    "Type your message to Ax..."

                setHintTextColor(
                    muted
                )

                setTextColor(
                    Color.WHITE
                )

                textSize = 18f

                isSingleLine =
                    false

                minLines = 5
                maxLines = 7

                gravity =
                    Gravity.TOP or
                    Gravity.START

                setPadding(
                    dp(18),
                    dp(18),
                    dp(18),
                    dp(18)
                )

                background =
                    rounded(
                        inputBg,
                        dp(16)
                    )

                includeFontPadding =
                    true

                isFocusable =
                    true

                isFocusableInTouchMode =
                    true

                isCursorVisible =
                    true

                setSelectAllOnFocus(
                    false
                )

                setOnFocusChangeListener {
                        view,
                        hasFocus ->

                    if (hasFocus) {

                        view.background =
                            rounded(
                                Color.rgb(
                                    25,
                                    33,
                                    48
                                ),
                                dp(16)
                            )

                    } else {

                        view.background =
                            rounded(
                                inputBg,
                                dp(16)
                            )
                    }
                }
            }

        val send =
            button("SEND TO AX") {

                val m =
                    input.text
                        .toString()
                        .trim()

                if (m.isEmpty()) {

                    input.requestFocus()

                    return@button
                }

                prefs.edit()
                    .putString(
                        "last_message",
                        m
                    )
                    .apply()

                HabitatWidget.refresh(
                    this
                )

                log.addView(
                    bubble(
                        "You",
                        m,
                        true
                    )
                )

                input.text.clear()

                input.requestFocus()

                scroll.post {
                    scroll.fullScroll(
                        View.FOCUS_DOWN
                    )
                }

                setStatus(
                    "● BRAIN ADAPTER: CONNECTING",
                    Color.rgb(
                        255,
                        190,
                        90
                    )
                )

                brainAdapter.send(m) { result ->

                    runOnUiThread {

                        when (result.state) {

                            BrainAdapter.State.CONNECTED -> {

                                setStatus(
                                    "● BRAIN ADAPTER: CONNECTED",
                                    Color.rgb(
                                        120,
                                        220,
                                        150
                                    )
                                )

                                log.addView(
                                    bubble(
                                        "Ax",
                                        result.text,
                                        false
                                    )
                                )
                            }

                            BrainAdapter.State.DISCONNECTED -> {

                                setStatus(
                                    "● BRAIN ADAPTER: NOT CONNECTED",
                                    Color.rgb(
                                        255,
                                        190,
                                        90
                                    )
                                )

                                log.addView(
                                    bubble(
                                        "Ax",
                                        "I saved that locally. The brain endpoint is not configured yet.",
                                        false
                                    )
                                )
                            }

                            BrainAdapter.State.ERROR -> {

                                setStatus(
                                    "● BRAIN ADAPTER: ERROR",
                                    Color.rgb(
                                        255,
                                        105,
                                        105
                                    )
                                )

                                log.addView(
                                    bubble(
                                        "Ax",
                                        "I couldn't reach the brain service.\n${result.detail}",
                                        false
                                    )
                                )
                            }

                            BrainAdapter.State.CONNECTING ->
                                Unit
                        }

                        scroll.post {
                            scroll.fullScroll(
                                View.FOCUS_DOWN
                            )
                        }
                    }
                }
            }

        root.addView(
            input,
            LinearLayout.LayoutParams(
                -1,
                dp(180)
            ).apply {

                topMargin =
                    dp(10)

                bottomMargin =
                    dp(8)
            }
        )

        root.addView(
            send,
            LinearLayout.LayoutParams(
                -1,
                dp(58)
            )
        )

        install(root)

        input.requestFocus()
    }

    private fun bubble(
        who: String,
        body: String,
        user: Boolean
    ): TextView =
        label(
            "$who • ${now()}\n$body",
            14f
        ).apply {

            setTextColor(
                Color.WHITE
            )

            setPadding(
                dp(14),
                dp(12),
                dp(14),
                dp(12)
            )

            background =
                rounded(
                    if (user)
                        Color.rgb(
                            28,
                            48,
                            68
                        )
                    else
                        card,
                    dp(14)
                )

            layoutParams =
                LinearLayout.LayoutParams(
                    -1,
                    -2
                ).apply {

                    topMargin =
                        dp(6)

                    bottomMargin =
                        dp(6)
                }
        }

    /*
     * =========================================================
     * PROJECTS
     * =========================================================
     */

    private fun showProjects() {

        val root = base()

        root.addView(
            header(
                "Projects",
                "Your active work in one place"
            )
        )

        root.addView(
            projectCard(
                "DropPilot AI",
                "67%",
                "Product research • TikTok Shop • Shopify"
            )
        )

        root.addView(
            projectCard(
                "GTA 6 Channel",
                "42%",
                "Scripts • images • editing • upload"
            )
        )

        root.addView(
            projectCard(
                "Habitat Development",
                "25%",
                "Android UI • brain • scenes • widgets"
            )
        )

        root.addView(
            button("+ NEW PROJECT") {

                Toast.makeText(
                    this,
                    "Project creation is ready for the next data layer",
                    Toast.LENGTH_SHORT
                ).show()
            },
            LinearLayout.LayoutParams(
                -1,
                dp(52)
            ).apply {
                topMargin = dp(8)
            }
        )

        install(root)
    }

    private fun projectCard(
        name: String,
        progress: String,
        sub: String
    ): View =
        LinearLayout(this).apply {

            orientation =
                LinearLayout.VERTICAL

            background =
                rounded(
                    card,
                    dp(15)
                )

            setPadding(
                dp(14),
                dp(12),
                dp(14),
                dp(12)
            )

            addView(
                LinearLayout(
                    this@MainActivity
                ).apply {

                    orientation =
                        LinearLayout.HORIZONTAL

                    addView(
                        label(
                            name,
                            16f
                        ),
                        LinearLayout.LayoutParams(
                            0,
                            -2,
                            1f
                        )
                    )

                    addView(
                        label(
                            progress,
                            16f,
                            accent
                        )
                    )
                }
            )

            addView(
                label(
                    sub,
                    12f,
                    muted
                ),
                LinearLayout.LayoutParams(
                    -1,
                    -2
                ).apply {
                    topMargin = dp(4)
                }
            )

            layoutParams =
                LinearLayout.LayoutParams(
                    -1,
                    dp(78)
                ).apply {
                    bottomMargin = dp(8)
                }
        }

    /*
     * =========================================================
     * BRAIN
     * =========================================================
     */

    private fun showBrain() {

        val root = base()

        root.addView(
            header(
                "Brain",
                "The control room for Habitat's intelligence layer"
            )
        )

        val endpoint =
            EditText(this).apply {

                hint =
                    "https://your-brain-endpoint.example/api/chat"

                setHintTextColor(
                    muted
                )

                setTextColor(
                    textColor
                )

                setSingleLine(
                    true
                )

                setText(
                    brainAdapter.endpoint()
                )

                background =
                    rounded(
                        card,
                        dp(12)
                    )

                setPadding(
                    dp(14),
                    dp(10),
                    dp(14),
                    dp(10)
                )
            }

        root.addView(
            endpoint,
            LinearLayout.LayoutParams(
                -1,
                dp(56)
            ).apply {
                topMargin = dp(10)
            }
        )

        root.addView(
            button("SAVE BRAIN ENDPOINT") {

                brainAdapter.setEndpoint(
                    endpoint.text.toString()
                )

                setStatus(
                    "● BRAIN ADAPTER: ENDPOINT SAVED",
                    Color.rgb(
                        120,
                        220,
                        150
                    )
                )

                Toast.makeText(
                    this,
                    "Brain endpoint saved",
                    Toast.LENGTH_SHORT
                ).show()
            },
            LinearLayout.LayoutParams(
                -1,
                dp(50)
            ).apply {
                topMargin = dp(7)
            }
        )

        val items =
            listOf(

                "Brain Adapter" to
                    if (
                        brainAdapter
                            .endpoint()
                            .isBlank()
                    )
                        "NOT CONNECTED"
                    else
                        "ENDPOINT READY",

                "Memory / Context" to
                    "LOCAL SHELL READY",

                "Projects" to
                    "3 ACTIVE",

                "Automations" to
                    "FOUNDATION READY",

                "System Health" to
                    "GOOD"
            )

        items.forEach { (a, b) ->

            root.addView(
                infoRow(
                    a,
                    b,
                    "Habitat core"
                )
            )
        }

        root.addView(
            button("TEST BRAIN CONNECTION") {

                val current =
                    endpoint.text
                        .toString()
                        .trim()

                if (current.isBlank()) {

                    Toast.makeText(
                        this,
                        "Enter a brain endpoint first",
                        Toast.LENGTH_SHORT
                    ).show()

                    return@button
                }

                brainAdapter.setEndpoint(
                    current
                )

                setStatus(
                    "● BRAIN ADAPTER: CONNECTING",
                    Color.rgb(
                        255,
                        190,
                        90
                    )
                )

                brainAdapter.send(
                    "Habitat connection test"
                ) { result ->

                    runOnUiThread {

                        when (result.state) {

                            BrainAdapter.State.CONNECTED -> {

                                setStatus(
                                    "● BRAIN ADAPTER: CONNECTED",
                                    Color.rgb(
                                        120,
                                        220,
                                        150
                                    )
                                )

                                Toast.makeText(
                                    this,
                                    "Brain connection succeeded",
                                    Toast.LENGTH_SHORT
                                ).show()
                            }

                            BrainAdapter.State.ERROR -> {

                                setStatus(
                                    "● BRAIN ADAPTER: ERROR",
                                    Color.rgb(
                                        255,
                                        105,
                                        105
                                    )
                                )

                                Toast.makeText(
                                    this,
                                    "Brain test failed: ${result.detail}",
                                    Toast.LENGTH_LONG
                                ).show()
                            }

                            else -> {

                                setStatus(
                                    "● BRAIN ADAPTER: NOT CONNECTED",
                                    Color.rgb(
                                        255,
                                        190,
                                        90
                                    )
                                )
                            }
                        }
                    }
                }
            },
            LinearLayout.LayoutParams(
                -1,
                dp(52)
            ).apply {
                topMargin = dp(8)
            }
        )

        root.addView(
            label(
                "The app does not contain an AI API key. Habitat calls the brain endpoint securely through the Brain Adapter.",
                12f,
                muted
            ),
            LinearLayout.LayoutParams(
                -1,
                -2
            ).apply {
                topMargin = dp(12)
            }
        )

        install(root)
    }

    /*
     * =========================================================
     * SCENES
     * =========================================================
     */

    private fun showScenes() {

        val root = base()

        root.addView(
            header(
                "Scenes",
                "Switch Ax's environment without changing the brain"
            )
        )

        val scenes =
            listOf(
                "Desk" to
                    "Command center",

                "Chat" to
                    "Just you and Ax",

                "Planning" to
                    "Ideas → action",

                "Relax" to
                    "Unwind and reset",

                "Night City" to
                    "Same Ax, different atmosphere"
            )

        scenes.forEach { (name, desc) ->

            val b =
                button(
                    "${sceneIcon(name)}  $name\n$desc"
                ) {

                    prefs.edit()
                        .putString(
                            "scene",
                            name
                        )
                        .apply()

                    HabitatWidget.refresh(
                        this
                    )

                    Toast.makeText(
                        this,
                        "Scene: $name",
                        Toast.LENGTH_SHORT
                    ).show()

                    animateAx()
                }

            b.gravity =
                Gravity.CENTER_VERTICAL or
                Gravity.START

            root.addView(
                b,
                LinearLayout.LayoutParams(
                    -1,
                    dp(64)
                ).apply {
                    bottomMargin =
                        dp(8)
                }
            )
        }

        install(root)
    }

    private fun sceneIcon(
        name: String
    ) =
        when (name) {

            "Desk" ->
                "🖥️"

            "Chat" ->
                "💬"

            "Planning" ->
                "🧠"

            "Relax" ->
                "🌙"

            else ->
                "🌃"
        }

    /*
     * =========================================================
     * MORE
     * =========================================================
     */

    private fun showMore() {

        val root = base()

        root.addView(
            header(
                "More",
                "Settings and quick controls"
            )
        )

        root.addView(
            button("AX APPEARANCE") {

                Toast.makeText(
                    this,
                    "2D Ax layer is installed in the core",
                    Toast.LENGTH_SHORT
                ).show()
            }
        )

        root.addView(
            button("NOTIFICATIONS") {

                Toast.makeText(
                    this,
                    "Notification foundation is ready for Android integration",
                    Toast.LENGTH_SHORT
                ).show()
            }
        )

        root.addView(
            button("WIDGETS") {

                Toast.makeText(
                    this,
                    "Widget foundation is installed",
                    Toast.LENGTH_SHORT
                ).show()
            }
        )

        root.addView(
            button("ABOUT HABITAT") {

                Toast.makeText(
                    this,
                    "Habitat v0.2.2 • Ax Edition",
                    Toast.LENGTH_LONG
                ).show()
            }
        )

        install(root)
    }

    /*
     * =========================================================
     * AX ANIMATION
     * =========================================================
     */

    private fun animateAx() {

        if (!::axImage.isInitialized)
            return

        val a =
            AlphaAnimation(
                .55f,
                1f
            )

        a.duration =
            450

        axImage.startAnimation(a)
    }
}
