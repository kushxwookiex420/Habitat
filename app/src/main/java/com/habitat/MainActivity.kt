package com.habitat

import android.app.Activity
import android.os.Bundle
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.EditText

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        window.setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN)
        window.navigationBarColor = android.graphics.Color.BLACK

        val root = FrameLayout(this)
        val space = Habitat3DSurface(this)
        val ui = HabitatOverlay(this)
        val input = EditText(this)
        input.hint = "Talk to Ax..."
        input.setSingleLine(true)
        input.setTextColor(android.graphics.Color.WHITE)
        input.setHintTextColor(android.graphics.Color.rgb(110,180,205))
        input.setTextSize(16f)
        input.setPadding(24,0,24,0)
        input.setBackgroundColor(android.graphics.Color.argb(220,5,20,35))
        input.visibility = android.view.View.GONE

        root.addView(space, FrameLayout.LayoutParams(-1,-1))
        root.addView(ui, FrameLayout.LayoutParams(-1,-1))
        val ip = FrameLayout.LayoutParams(-1,58)
        ip.leftMargin=36; ip.rightMargin=150; ip.topMargin=0
        root.addView(input,ip)

        ui.onSectionChanged = { section ->
            space.setMode(section)
            input.visibility = if(section==0) android.view.View.VISIBLE else android.view.View.GONE
        }
        ui.onChatSubmit = { msg ->
            input.setText("")
            ui.addChatMessage("YOU",msg)
            ui.addChatMessage("AX","Received. Habitat is listening and ready.")
        }
        input.setOnEditorActionListener { _,_,_ ->
            val s=input.text.toString().trim()
            if(s.isNotEmpty()){ ui.onChatSubmit?.invoke(s) }
            true
        }
        setContentView(root)
    }
}
