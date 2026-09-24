package com.habitat

import android.content.Context
import android.graphics.*
import android.view.MotionEvent
import android.view.View
import kotlin.math.*
import kotlin.random.Random

class GalaxyHabitatView(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stars = Array(260) { floatArrayOf(Random.nextFloat(), Random.nextFloat(), .35f + Random.nextFloat() * 1.65f) }
    private var time = 0f
    private var rotation = 0f
    private var lastX = 0f
    private var drag = false
    private var tab = 0
    private val tabs = arrayOf("CHAT", "MEMORY", "WORKERS", "AUTOMATIONS")

    init {
        isFocusable = true
        text.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> { lastX = e.x; drag = true; return true }
            MotionEvent.ACTION_MOVE -> {
                if (drag) { rotation += (e.x-lastX)*0.35f; lastX=e.x; invalidate() }
                return true
            }
            MotionEvent.ACTION_UP -> {
                drag = false
                val h = height.toFloat()
                if (e.y > h*.86f) {
                    val idx = ((e.x / width.toFloat()) * tabs.size).toInt().coerceIn(0,tabs.lastIndex)
                    tab = idx
                }
                invalidate()
                return true
            }
        }
        return true
    }

    override fun onDraw(c: Canvas) {
        val w=width.toFloat(); val h=height.toFloat()
        drawSpace(c,w,h)
        drawCore(c,w,h)
        drawTopStatus(c,w)
        drawBottomNav(c,w,h)
        time += .016f
        rotation *= .985f
        postInvalidateDelayed(16)
    }

    private fun drawSpace(c:Canvas,w:Float,h:Float) {
        paint.shader = LinearGradient(0f,0f,w,h, intArrayOf(Color.rgb(1,2,14),Color.rgb(7,2,30),Color.rgb(1,7,20)), null, Shader.TileMode.CLAMP)
        c.drawRect(0f,0f,w,h,paint); paint.shader=null
        val neb=RadialGradient(w*.35f,h*.42f,w*.62f,intArrayOf(Color.argb(80,60,20,160),Color.argb(20,20,90,150),Color.TRANSPARENT),null,Shader.TileMode.CLAMP)
        paint.shader=neb;c.drawCircle(w*.35f,h*.42f,w*.62f,paint);paint.shader=null
        val neb2=RadialGradient(w*.72f,h*.70f,w*.55f,intArrayOf(Color.argb(55,20,110,170),Color.argb(12,80,30,150),Color.TRANSPARENT),null,Shader.TileMode.CLAMP)
        paint.shader=neb2;c.drawCircle(w*.72f,h*.70f,w*.55f,paint);paint.shader=null
        paint.style=Paint.Style.FILL
        for (s in stars) {
            val x=(s[0]*w + sin(time*.10f+s[1]*12f)*8f + rotation*.15f)%w
            val y=s[1]*h
            paint.color=Color.argb((70+s[2]*85).toInt().coerceAtMost(220),180,220,255)
            c.drawCircle(if(x<0)x+w else x,y,s[2],paint)
        }
    }

    private fun drawCore(c:Canvas,w:Float,h:Float) {
        val cx=w*.5f; val cy=h*.43f; val r=min(w,h)*.255f
        val pulse=1f+sin(time*2.2f)*.018f
        c.save(); c.scale(pulse,pulse,cx,cy); c.rotate(rotation*.12f,cx,cy)
        paint.style=Paint.Style.STROKE
        paint.strokeWidth=2.2f
        paint.setShadowLayer(30f,0f,0f,Color.rgb(70,190,255))
        paint.color=Color.argb(150,105,225,255)
        val brain=Path()
        brain.moveTo(cx,cy-r*.72f)
        brain.cubicTo(cx-r*.55f,cy-r*.95f,cx-r*.92f,cy-r*.48f,cx-r*.78f,cy)
        brain.cubicTo(cx-r*.95f,cy+r*.52f,cx-r*.45f,cy+r*.78f,cx-r*.05f,cy+r*.68f)
        brain.moveTo(cx,cy-r*.72f)
        brain.cubicTo(cx+r*.55f,cy-r*.95f,cx+r*.92f,cy-r*.48f,cx+r*.78f,cy)
        brain.cubicTo(cx+r*.95f,cy+r*.52f,cx+r*.45f,cy+r*.78f,cx+r*.05f,cy+r*.68f)
        c.drawPath(brain,paint); paint.clearShadowLayer()
        paint.strokeWidth=1.1f; paint.color=Color.argb(130,130,235,255)
        for(i in 0..16){
            val yy=cy-r*.62f+i*r*.078f
            val bend=sin(time*1.3f+i*.65f)*r*.10f
            val p=Path();p.moveTo(cx-r*.66f,yy);p.cubicTo(cx-r*.25f,yy-bend,cx+r*.25f,yy+bend,cx+r*.66f,yy);c.drawPath(p,paint)
        }
        paint.color=Color.argb(185,175,245,255)
        c.drawLine(cx,cy-r*.65f,cx,cy+r*.62f,paint)
        paint.style=Paint.Style.FILL
        for(i in 0..34){
            val a=i*1.71f+time*.35f
            val rr=r*(.18f+(i%7)*.075f)
            val x=cx+cos(a)*rr; val y=cy+sin(a)*rr*.78f
            paint.color=Color.argb(190,110,230,255)
            c.drawCircle(x,y,1.6f+abs(sin(time*3f+i))*1.8f,paint)
        }
        paint.style=Paint.Style.STROKE; paint.strokeWidth=1.0f; paint.color=Color.argb(75,120,220,255)
        c.drawOval(cx-r*1.08f,cy-r*.36f,cx+r*1.08f,cy+r*.36f,paint)
        c.drawOval(cx-r*.76f,cy-r*1.08f,cx+r*.76f,cy+r*1.08f,paint)
        c.restore()
    }

    private fun drawTopStatus(c:Canvas,w:Float) {
        text.textAlign=Paint.Align.CENTER
        text.color=Color.WHITE;text.textSize=25f
        c.drawText("HABITAT",w/2f,42f,text)
        text.textSize=11f;text.color=Color.rgb(135,215,255)
        c.drawText("AX  •  NEURAL CORE ONLINE",w/2f,61f,text)
        text.textSize=9f;text.color=Color.argb(150,210,230,255)
        c.drawText(when(tab){0->"READY";1->"MEMORY LINK";2->"WORKER MESH";else->"AUTOMATION GRID"},w/2f,78f,text)
    }

    private fun drawBottomNav(c:Canvas,w:Float,h:Float) {
        val barY=h*.88f
        paint.style=Paint.Style.STROKE;paint.strokeWidth=1f;paint.color=Color.argb(70,130,210,255)
        c.drawRoundRect(w*.04f,barY,w*.96f,h*.98f,24f,24f,paint)
        val cell=w/tabs.size
        text.textSize=10f;text.textAlign=Paint.Align.CENTER
        for(i in tabs.indices){
            text.color=if(i==tab)Color.WHITE else Color.argb(150,180,215,235)
            c.drawText(tabs[i],cell*(i+.5f),barY+34f,text)
            if(i==tab){paint.style=Paint.Style.FILL;paint.color=Color.argb(170,105,220,255);c.drawCircle(cell*(i+.5f),barY+13f,2.5f,paint)}
        }
    }
}
