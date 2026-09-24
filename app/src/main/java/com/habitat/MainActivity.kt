package com.habitat

import android.app.Activity
import android.os.Bundle
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        window.setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN)
        window.navigationBarColor = android.graphics.Color.BLACK
        val root = FrameLayout(this)
        val space = Habitat3DSurface(this)
        val ui = HabitatOverlay(this)
        root.addView(space, FrameLayout.LayoutParams(-1,-1))
        root.addView(ui, FrameLayout.LayoutParams(-1,-1))
        ui.onSectionChanged = { space.setMode(it) }
        setContentView(root)
    }
}
