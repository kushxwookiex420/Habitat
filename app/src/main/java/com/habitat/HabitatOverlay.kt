package com.habitat

import android.content.Context
import android.graphics.*
import android.view.MotionEvent
import android.view.View
import kotlin.math.min

class HabitatOverlay(ctx:Context):View(ctx){
    var onSectionChanged:((Int)->Unit)?=null
    var onChatSubmit:((String)->Unit)?=null
    private val names=arrayOf("CHAT","WORKERS","TASKS","NOTIFICATIONS")
    private var selected=0
    private var panel=false
    private val messages=mutableListOf("AX  •  Neural core online.","Ask me anything. I can route work to Habitat workers.")
    private val paint=Paint(Paint.ANTI_ALIAS_FLAG)

    fun addChatMessage(who:String,msg:String){messages.add("$who  •  $msg"); if(messages.size>8)messages.removeAt(0); invalidate()}

    override fun onDraw(c:Canvas){
        super.onDraw(c)
        val s=min(width,height).toFloat()
        paint.typeface=Typeface.create(Typeface.DEFAULT,Typeface.BOLD)
        paint.textAlign=Paint.Align.CENTER
        paint.color=Color.WHITE; paint.textSize=s*.065f
        c.drawText("HABITAT",width/2f,height*.075f,paint)
        paint.color=Color.rgb(125,225,255); paint.textSize=s*.028f
        c.drawText("AX  •  NEURAL COMMAND CENTER",width/2f,height*.115f,paint)

        val y=height*.82f; val cell=width/4f
        for(i in 0..3){
            val l=cell*i+8; val r=cell*(i+1)-8
            paint.style=Paint.Style.FILL
            paint.color=if(i==selected)Color.argb(225,15,92,130)else Color.argb(190,3,17,32)
            c.drawRoundRect(l,y,r,y+height*.105f,24f,24f,paint)
            paint.style=Paint.Style.STROKE; paint.strokeWidth=3f
            paint.color=if(i==selected)Color.rgb(75,225,255)else Color.rgb(32,105,135)
            c.drawRoundRect(l,y,r,y+height*.105f,24f,24f,paint)
            paint.style=Paint.Style.FILL; paint.color=Color.WHITE; paint.textSize=s*.028f
            c.drawText(names[i],(l+r)/2f,y+height*.064f,paint)
        }

        if(panel){
            paint.color=Color.argb(242,2,10,25); paint.style=Paint.Style.FILL
            c.drawRoundRect(width*.045f,height*.20f,width*.955f,height*.78f,30f,30f,paint)
            paint.color=Color.rgb(95,225,255);paint.textSize=s*.052f
            c.drawText(names[selected],width/2f,height*.28f,paint)
            paint.color=Color.WHITE;paint.textSize=s*.031f
            when(selected){
                0 -> {
                    var yy=height*.36f
                    for(m in messages.takeLast(6)){c.drawText(m.take(52),width/2f,yy,paint);yy+=height*.058f}
                    paint.color=Color.rgb(100,210,240);paint.textSize=s*.024f
                    c.drawText("TYPE IN THE FIELD ABOVE • ENTER TO SEND",width/2f,height*.73f,paint)
                }
                1 -> {
                    c.drawText("WORKER MESH",width/2f,height*.38f,paint)
                    c.drawText("Claude     •     READY",width/2f,height*.47f,paint)
                    c.drawText("Muse       •     READY",width/2f,height*.54f,paint)
                    c.drawText("Ax         •     ORCHESTRATOR",width/2f,height*.61f,paint)
                }
                2 -> {
                    c.drawText("TASK QUEUE",width/2f,height*.38f,paint)
                    c.drawText("• Build Habitat v0.4     ACTIVE",width/2f,height*.48f,paint)
                    c.drawText("• Connect worker mesh   READY",width/2f,height*.55f,paint)
                    c.drawText("• Automate DropPilot    QUEUED",width/2f,height*.62f,paint)
                }
                3 -> {
                    c.drawText("NOTIFICATION CENTER",width/2f,height*.38f,paint)
                    c.drawText("✓ Habitat core online",width/2f,height*.48f,paint)
                    c.drawText("✓ Worker mesh available",width/2f,height*.55f,paint)
                    c.drawText("! No new alerts",width/2f,height*.62f,paint)
                }
            }
            paint.color=Color.rgb(90,200,230);paint.textSize=s*.022f
            c.drawText("TAP PANEL TO RETURN",width/2f,height*.745f,paint)
        }
    }

    override fun onTouchEvent(e:MotionEvent):Boolean{
        if(e.actionMasked!=MotionEvent.ACTION_UP)return true
        if(panel && e.y<height*.80f){panel=false;invalidate();return true}
        if(e.y>height*.79f){
            selected=((e.x/(width/4f)).toInt()).coerceIn(0,3)
            panel=true
            onSectionChanged?.invoke(selected)
            invalidate()
            return true
        }
        return true
    }
}
