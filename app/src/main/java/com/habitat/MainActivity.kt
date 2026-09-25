package com.habitat

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognizerIntent
import android.view.Gravity
import android.view.Window
import android.view.WindowManager
import android.widget.*
import android.graphics.Color
import java.util.Locale

class MainActivity : Activity() {
    private lateinit var input:EditText
    private lateinit var ui:HabitatOverlay
    private val voiceCode=700

    override fun onCreate(savedInstanceState:Bundle?){
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        window.setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,WindowManager.LayoutParams.FLAG_FULLSCREEN)
        window.navigationBarColor=Color.BLACK

        val root=FrameLayout(this)
        val space=Habitat3DSurface(this)
        ui=HabitatOverlay(this)
        root.addView(space,FrameLayout.LayoutParams(-1,-1))
        root.addView(ui,FrameLayout.LayoutParams(-1,-1))

        // Professional bottom composer: always reachable, never hidden at the top.
        val composer=LinearLayout(this)
        composer.orientation=LinearLayout.HORIZONTAL
        composer.gravity=Gravity.CENTER_VERTICAL
        composer.setPadding(14,8,14,8)
        composer.setBackgroundColor(Color.argb(235,3,14,27))

        input=EditText(this)
        input.hint="Message Ax"
        input.setSingleLine(true)
        input.setTextColor(Color.WHITE)
        input.setHintTextColor(Color.rgb(110,180,205))
        input.textSize=17f
        input.setPadding(18,0,12,0)
        input.setBackgroundColor(Color.argb(210,8,28,45))
        val inputLp=LinearLayout.LayoutParams(0,58,1f)
        composer.addView(input,inputLp)

        val voice=Button(this)
        voice.text="◉"
        voice.textSize=18f
        voice.setTextColor(Color.WHITE)
        voice.setBackgroundColor(Color.rgb(9,75,103))
        composer.addView(voice,LinearLayout.LayoutParams(70,58).apply{leftMargin=8})

        val send=Button(this)
        send.text="➤"
        send.textSize=22f
        send.setTextColor(Color.WHITE)
        send.setBackgroundColor(Color.rgb(10,115,145))
        composer.addView(send,LinearLayout.LayoutParams(74,58).apply{leftMargin=8})

        val cp=FrameLayout.LayoutParams(-1,76,Gravity.BOTTOM)
        cp.setMargins(16,0,16,190)
        root.addView(composer,cp)

        fun submit(){
            val s=input.text.toString().trim()
            if(s.isNotEmpty()){input.setText("");ui.addChatMessage("YOU",s);ui.addChatMessage("AX","Received. I’m routing that through Habitat.");}
        }
        send.setOnClickListener{submit()}
        input.setOnEditorActionListener{_,_,_->submit();true}
        voice.setOnClickListener{startVoice()}

        ui.onSectionChanged={section->
            space.setMode(section)
            // Chat composer remains available so the user can always talk to Ax.
            composer.visibility=android.view.View.VISIBLE
        }
        setContentView(root)
    }

    private fun startVoice(){
        try{
            val intent=Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE,Locale.getDefault())
            intent.putExtra(RecognizerIntent.EXTRA_PROMPT,"Talk to Ax")
            startActivityForResult(intent,voiceCode)
        }catch(_:Exception){
            Toast.makeText(this,"Voice input isn't available on this device.",Toast.LENGTH_SHORT).show()
        }
    }

    override fun onActivityResult(requestCode:Int,resultCode:Int,data:Intent?){
        super.onActivityResult(requestCode,resultCode,data)
        if(requestCode==voiceCode && resultCode==RESULT_OK){
            val text=data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
            if(!text.isNullOrBlank()){input.setText(text);input.setSelection(input.length())}
        }
    }
}
