package com.habitat

import android.content.Context
import android.graphics.*
import android.view.MotionEvent
import android.view.View
import kotlin.math.min

class HabitatOverlay(ctx:Context):View(ctx){
    var onSectionChanged:((Int)->Unit)?=null
    private val names=arrayOf("CHAT","MEMORY","WORKERS","AUTOMATIONS")
    private var selected=0; private var panel=false
    private val paint=Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(c:Canvas){
        paint.typeface=Typeface.create(Typeface.DEFAULT,Typeface.BOLD);paint.textAlign=Paint.Align.CENTER
        paint.color=Color.WHITE;paint.textSize=min(width,height)*.065f;c.drawText("HABITAT",width/2f,height*.075f,paint)
        paint.color=Color.rgb(125,225,255);paint.textSize=min(width,height)*.032f;c.drawText("AX  •  NEURAL CORE",width/2f,height*.115f,paint)
        val y=height*.82f;val cell=width/4f
        for(i in 0..3){
            val l=cell*i+10;val r=cell*(i+1)-10
            paint.style=Paint.Style.FILL;paint.color=if(i==selected)Color.argb(215,18,80,115)else Color.argb(165,4,18,35);c.drawRoundRect(l,y,r,y+height*.095f,22f,22f,paint)
            paint.style=Paint.Style.STROKE;paint.strokeWidth=3f;paint.color=if(i==selected)Color.rgb(80,220,255)else Color.rgb(35,105,135);c.drawRoundRect(l,y,r,y+height*.095f,22f,22f,paint)
            paint.style=Paint.Style.FILL;paint.color=Color.WHITE;paint.textSize=min(width,height)*.032f;c.drawText(names[i],(l+r)/2f,y+height*.06f,paint)
        }
        if(panel){
            paint.color=Color.argb(238,3,9,25);paint.style=Paint.Style.FILL;c.drawRoundRect(width*.07f,height*.54f,width*.93f,height*.78f,28f,28f,paint)
            paint.color=Color.rgb(110,225,255);paint.textSize=min(width,height)*.055f;c.drawText(names[selected],width/2f,height*.61f,paint)
            paint.color=Color.WHITE;paint.textSize=min(width,height)*.034f
            val body=when(selected){0->"AX CHAT\nCommand center ready.";1->"MEMORY CORE\nHabitat context and project state.";2->"WORKER MESH\nExternal AI workers report to Ax.";else->"AUTOMATIONS\nRoutines run from Habitat."}
            body.split("\n").forEachIndexed{i,s->c.drawText(s,width/2f,height*(.665f+i*.055f),paint)}
            paint.color=Color.rgb(100,220,255);paint.textSize=min(width,height)*.026f;c.drawText("TAP THE BRAIN TO CLOSE",width/2f,height*.755f,paint)
        }
    }
    override fun onTouchEvent(e:MotionEvent):Boolean{
        if(e.actionMasked!=MotionEvent.ACTION_UP)return true
        if(panel && e.y<height*.8f && e.y>height*.2f){panel=false;invalidate();return true}
        if(e.y>height*.79f){selected=((e.x/(width/4f)).toInt()).coerceIn(0,3);panel=true;onSectionChanged?.invoke(selected);invalidate()}
        return true
    }
}
