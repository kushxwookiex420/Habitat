package com.habitat

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognizerIntent
import android.view.Gravity
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.widget.*
import org.json.JSONObject
import android.graphics.Color
import java.util.Locale

class MainActivity : Activity() {
    private lateinit var input: EditText
    private lateinit var ui: HabitatOverlay
    private lateinit var brain: BrainAdapter
    private val voiceCode = 700

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        window.setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN)
        window.navigationBarColor = Color.BLACK
        brain = BrainAdapter(this)

        val root = FrameLayout(this)
        val space = Habitat3DSurface(this)
        ui = HabitatOverlay(this)
        root.addView(space, FrameLayout.LayoutParams(-1, -1))
        root.addView(ui, FrameLayout.LayoutParams(-1, -1))

        val composer = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(12, 8, 12, 8)
            setBackgroundColor(Color.argb(242, 2, 12, 24))
            elevation = 18f
        }

        input = EditText(this).apply {
            hint = "Message Ax…"
            setSingleLine(false)
            minLines = 1
            maxLines = 5
            gravity = Gravity.CENTER_VERTICAL
            setHorizontallyScrolling(false)
            filters = arrayOf(android.text.InputFilter.LengthFilter(12000))
            setTextColor(Color.WHITE)
            setHintTextColor(Color.rgb(110, 190, 215))
            textSize = 17f
            setPadding(18, 0, 12, 0)
            setBackgroundColor(Color.argb(225, 7, 29, 48))
        }
        composer.addView(input, LinearLayout.LayoutParams(0, 82, 1f))

        val voice = Button(this).apply {
            text = "◉"
            textSize = 18f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(7, 79, 108))
            isAllCaps = false
        }
        composer.addView(voice, LinearLayout.LayoutParams(64, 82).apply { leftMargin = 8 })

        val send = Button(this).apply {
            text = "➤"
            textSize = 22f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(8, 122, 154))
            isAllCaps = false
        }
        composer.addView(send, LinearLayout.LayoutParams(70, 82).apply { leftMargin = 8 })

        // The command composer lives above the Samsung navigation area and above
        // the bottom navigation rail instead of being pinned to the screen bottom.
        val cp = FrameLayout.LayoutParams(-1, 104, Gravity.TOP)
        cp.setMargins(14, 0, 14, 0)
        root.addView(composer, cp)

        fun positionComposer() {
            val usable = root.height
            if (usable <= 0) return
            val lp = composer.layoutParams as FrameLayout.LayoutParams
            lp.topMargin = (usable * 0.695f).toInt()
            composer.layoutParams = lp
        }
        root.post { positionComposer() }
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> positionComposer() }

        fun setBusy(busy: Boolean) {
            input.isEnabled = !busy
            send.isEnabled = !busy
            voice.isEnabled = !busy
            send.text = if (busy) "…" else "➤"
        }

        fun submit() {
            val message = input.text.toString().trim()
            if (message.isEmpty() || !input.isEnabled) return
            input.setText("")
            ui.openChat()
            ui.addChatMessage("YOU", message)
            ui.addChatMessage("AX", "Thinking…")
            setBusy(true)

            val mission = message.lowercase(Locale.US)
            val isDropPilotMission = mission.contains("run droppilot") ||
                mission.contains("drop pilot mission") ||
                mission.startsWith("droppilot:")
            val isViceCityMission = mission.contains("run vice city") ||
                mission.contains("vice city files") ||
                mission.startsWith("vicecity:")

            if (isViceCityMission) {
                ui.addChatMessage("AX", "Dispatching Topic Scout + Script Editor + Channel Operator…")
                val channelContext = JSONObject().apply {
                    put("channel", "Vice City Files")
                    put("handle", "@ViceCityFilesYT")
                    put("format", "16:9 photo/video")
                    put("editing", "CapCut")
                    put("voice", "calm, gentle, smooth TTS")
                    put("introSeconds", 7)
                    put("goal", "repeatable YouTube/TikTok content pipeline")
                }
                brain.sendViceCity(message, channelContext) { result ->
                    runOnUiThread {
                        setBusy(false)
                        when (result.state) {
                            BrainAdapter.State.CONNECTED -> ui.replaceLastAxMessage(result.text)
                            BrainAdapter.State.ERROR -> ui.replaceLastAxMessage("Vice City mission failed: " + result.detail)
                            BrainAdapter.State.DISCONNECTED -> ui.replaceLastAxMessage("Vice City operator disconnected.")
                            BrainAdapter.State.CONNECTING -> Unit
                        }
                    }
                }
            } else if (isDropPilotMission) {
                ui.setDropPilotMissionState(true)
                ui.addChatMessage("AX", "Dispatching Product Scout + Listing Optimizer + Growth Operator…")
                val storeContext = JSONObject().apply {
                    put("store", "Stevvex")
                    put("platform", "Shopify Basic + TikTok Shop US")
                    put("orders", 0)
                    put("activeProducts", 1)
                    put("currentProduct", "Car Seat Gap Organizer / Storage Pocket")
                    put("currentPrice", 21.99)
                    put("compareAtPrice", 45.00)
                    put("supplierMarginPercent", 40)
                    put("creatorCommissionPercent", 14.5)
                    put("shipsFromUS", true)
                    put("inventory", "high")
                    put("goal", "first sale today, then repeatable daily sales")
                }
                brain.sendDropPilot(message, storeContext) { result ->
                    runOnUiThread {
                        setBusy(false)
                        when (result.state) {
                            BrainAdapter.State.CONNECTED -> {
                                ui.setDropPilotMissionState(false, true)
                                ui.replaceLastAxMessage(result.text)
                            }
                            BrainAdapter.State.ERROR -> {
                                ui.setDropPilotMissionState(false, false)
                                ui.replaceLastAxMessage("DropPilot mission failed: " + result.detail)
                            }
                            BrainAdapter.State.DISCONNECTED -> {
                                ui.setDropPilotMissionState(false, false)
                                ui.replaceLastAxMessage("DropPilot brain disconnected.")
                            }
                            BrainAdapter.State.CONNECTING -> Unit
                        }
                    }
                }
            } else {
                brain.send(message) { result ->
                    runOnUiThread {
                        setBusy(false)
                        when (result.state) {
                            BrainAdapter.State.CONNECTED -> ui.replaceLastAxMessage(result.text)
                            BrainAdapter.State.ERROR -> ui.replaceLastAxMessage("I couldn't reach the Habitat brain. " + result.detail)
                            BrainAdapter.State.DISCONNECTED -> ui.replaceLastAxMessage("Habitat brain disconnected.")
                            BrainAdapter.State.CONNECTING -> Unit
                        }
                    }
                }
            }
        }

        send.setOnClickListener { submit() }
        input.setOnEditorActionListener { _, _, _ -> submit(); true }
        voice.setOnClickListener { startVoice() }

        ui.onSectionChanged = { section ->
            space.setMode(section)
            composer.visibility = View.VISIBLE
        }

        setContentView(root)
    }

    private fun startVoice() {
        if (android.os.Build.VERSION.SDK_INT >= 23 &&
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 701)
            return
        }
        try {
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
            intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "Talk to Ax")
            startActivityForResult(intent, voiceCode)
        } catch (_: Exception) {
            Toast.makeText(this, "Voice input isn't available on this device.", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroy() {
        brain.shutdown()
        super.onDestroy()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == voiceCode && resultCode == RESULT_OK) {
            val text = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
            if (!text.isNullOrBlank()) {
                input.setText(text)
                input.setSelection(input.length())
            }
        }
    }
}
