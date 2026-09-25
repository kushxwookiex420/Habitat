package com.habitat

import android.content.Context
import android.graphics.*
import android.view.MotionEvent
import android.view.View
import kotlin.math.min

class HabitatOverlay(ctx:Context):View(ctx){
    var onSectionChanged:((Int)->Unit)?=null
    var onChatSubmit:((String)->Unit)?=null
    var onVoiceRequest:(()->Unit)?=null
    private val names=arrayOf("CHAT","WORKERS","TASKS","NOTIFY")
    private var selected=0
    private var panel=false
    private val messages=mutableListOf("AX  •  Neural core online.","Ready. Give me a command or delegate a task.")
    private val paint=Paint(Paint.ANTI_ALIAS_FLAG)

    fun addChatMessage(who:String,msg:String){messages.add("$who  •  $msg");if(messages.size>10)messages.removeAt(0);invalidate()}

    override fun onDraw(c:Canvas){
        super.onDraw(c)
        val s=min(width,height).toFloat()
        paint.typeface=Typeface.create(Typeface.DEFAULT,Typeface.BOLD)
        paint.textAlign=Paint.Align.CENTER
        paint.style=Paint.Style.FILL
        paint.color=Color.WHITE;paint.textSize=s*.062f
        c.drawText("HABITAT",width/2f,height*.075f,paint)
        paint.color=Color.rgb(105,225,255);paint.textSize=s*.024f
        c.drawText("AX  /  NEURAL COMMAND CENTER",width/2f,height*.112f,paint)

        // subtle glass header line
        paint.color=Color.argb(90,90,220,255);paint.strokeWidth=2f
        c.drawLine(width*.08f,height*.145f,width*.92f,height*.145f,paint)

        if(panel){
            paint.color=Color.argb(228,3,10,25);paint.style=Paint.Style.FILL
            c.drawRoundRect(width*.045f,height*.19f,width*.955f,height*.72f,34f,34f,paint)
            paint.style=Paint.Style.STROKE;paint.strokeWidth=2.5f;paint.color=Color.argb(180,75,215,255)
            c.drawRoundRect(width*.045f,height*.19f,width*.955f,height*.72f,34f,34f,paint)
            paint.style=Paint.Style.FILL;paint.color=Color.WHITE;paint.textSize=s*.044f
            c.drawText(names[selected],width/2f,height*.27f,paint)
            paint.color=Color.rgb(170,225,240);paint.textSize=s*.026f
            when(selected){
                0->{var yy=height*.35f;for(m in messages.takeLast(7)){c.drawText(m.take(48),width/2f,yy,paint);yy+=height*.052f}
                    paint.color=Color.rgb(75,210,245);paint.textSize=s*.021f
                    c.drawText("COMPOSER BELOW  •  TEXT OR VOICE",width/2f,height*.68f,paint)}
                1->{c.drawText("WORKER MESH",width/2f,height*.36f,paint);c.drawText("AX  •  ORCHESTRATOR",width/2f,height*.45f,paint);c.drawText("CLAUDE  •  READY",width/2f,height*.52f,paint);c.drawText("MUSE  •  READY",width/2f,height*.59f,paint);c.drawText("DELEGATION CHANNEL  •  ONLINE",width/2f,height*.66f,paint)}
                2->{c.drawText("ACTIVE QUEUE",width/2f,height*.36f,paint);c.drawText("Build Habitat  •  ACTIVE",width/2f,height*.46f,paint);c.drawText("Worker mesh  •  READY",width/2f,height*.53f,paint);c.drawText("DropPilot automation  •  QUEUED",width/2f,height*.60f,paint);c.drawText("Tap a task to inspect",width/2f,height*.67f,paint)}
                3->{c.drawText("SYSTEM STATUS",width/2f,height*.36f,paint);c.drawText("Habitat core  •  ONLINE",width/2f,height*.46f,paint);c.drawText("Neural renderer  •  ONLINE",width/2f,height*.53f,paint);c.drawText("Worker mesh  •  ONLINE",width/2f,height*.60f,paint);c.drawText("No critical alerts",width/2f,height*.67f,paint)}
            }
        }

        // bottom navigation
        val y=height*.87f;val cell=width/4f
        for(i in 0..3){
            val l=cell*i+7;val r=cell*(i+1)-7
            paint.style=Paint.Style.FILL
            paint.color=if(i==selected)Color.argb(220,12,92,125)else Color.argb(205,3,15,29)
            c.drawRoundRect(l,y,r,y+height*.065f,22f,22f,paint)
            paint.style=Paint.Style.STROKE;paint.strokeWidth=2.5f
            paint.color=if(i==selected)Color.rgb(80,225,255)else Color.rgb(30,100,130)
            c.drawRoundRect(l,y,r,y+height*.09f,22f,22f,paint)
            paint.style=Paint.Style.FILL;paint.color=Color.WHITE;paint.textSize=s*.022f
            c.drawText(names[i],(l+r)/2f,y+height*.041f,paint)
        }
    }

    override fun onTouchEvent(e:MotionEvent):Boolean{
        if(e.actionMasked!=MotionEvent.ACTION_UP)return true
        if(e.y>height*.85f){
            selected=((e.x/(width/4f)).toInt()).coerceIn(0,3)
            panel=true
            onSectionChanged?.invoke(selected)
            invalidate();return true
        }
        // Let the native composer own its area; tapping elsewhere closes an open panel.
        if(panel && e.y<height*.78f){panel=false;invalidate();return true}
        return true
    }
}
