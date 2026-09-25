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
import android.graphics.Color
import java.util.Locale

class MainActivity : Activity() {
    private lateinit var input: EditText
    private lateinit var ui: HabitatOverlay
    private val voiceCode = 700

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        window.setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN)
        window.navigationBarColor = Color.BLACK

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
            setSingleLine(true)
            setTextColor(Color.WHITE)
            setHintTextColor(Color.rgb(110, 190, 215))
            textSize = 17f
            setPadding(18, 0, 12, 0)
            setBackgroundColor(Color.argb(225, 7, 29, 48))
        }
        composer.addView(input, LinearLayout.LayoutParams(0, 58, 1f))

        val voice = Button(this).apply {
            text = "◉"
            textSize = 18f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(7, 79, 108))
            isAllCaps = false
        }
        composer.addView(voice, LinearLayout.LayoutParams(64, 58).apply { leftMargin = 8 })

        val send = Button(this).apply {
            text = "➤"
            textSize = 22f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(8, 122, 154))
            isAllCaps = false
        }
        composer.addView(send, LinearLayout.LayoutParams(70, 58).apply { leftMargin = 8 })

        // The command composer lives above the Samsung navigation area and above
        // the bottom navigation rail instead of being pinned to the screen bottom.
        val cp = FrameLayout.LayoutParams(-1, 78, Gravity.TOP)
        cp.setMargins(14, 0, 14, 0)
        root.addView(composer, cp)

        fun positionComposer() {
            val usable = root.height
            if (usable <= 0) return
            val lp = composer.layoutParams as FrameLayout.LayoutParams
            lp.topMargin = (usable * 0.715f).toInt()
            composer.layoutParams = lp
        }
        root.post { positionComposer() }
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> positionComposer() }

        fun submit() {
            val s = input.text.toString().trim()
            if (s.isNotEmpty()) {
                input.setText("")
                ui.addChatMessage("YOU", s)
                ui.addChatMessage("AX", "Received. I’m routing that through Habitat.")
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
