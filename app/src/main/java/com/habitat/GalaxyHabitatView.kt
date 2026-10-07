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
    private val stars = Array(320) { floatArrayOf(Random.nextFloat(), Random.nextFloat(), .25f + Random.nextFloat() * 1.8f, Random.nextFloat()) }
    private var time = 0f
    private var rotation = 0f
    private var lastX = 0f
    private var drag = false
    private var tab = 0
    private val tabs = arrayOf("CHAT", "PROJECTS", "WORKERS", "TASKS")
    private val axBrain = BitmapFactory.decodeResource(resources, R.drawable.ax_brain)

    init {
        isFocusable = true
        text.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        setLayerType(View.LAYER_TYPE_SOFTWARE, null)
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> { lastX = e.x; drag = true; return true }
            MotionEvent.ACTION_MOVE -> {
                if (drag) { rotation += (e.x-lastX)*0.22f; lastX=e.x; invalidate() }
                return true
            }
            MotionEvent.ACTION_UP -> {
                drag = false
                val h = height.toFloat()
                if (e.y > h*.86f) tab = ((e.x / width.toFloat()) * tabs.size).toInt().coerceIn(0,tabs.lastIndex)
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
        paint.style=Paint.Style.FILL
        paint.shader=LinearGradient(0f,0f,w,h,
            intArrayOf(Color.rgb(1,2,13),Color.rgb(5,2,24),Color.rgb(1,8,20),Color.rgb(2,1,12)),
            floatArrayOf(0f,.38f,.72f,1f),Shader.TileMode.CLAMP)
        c.drawRect(0f,0f,w,h,paint); paint.shader=null

        val milkyWay=RadialGradient(w*.50f,h*.46f,w*.72f,
            intArrayOf(Color.argb(95,75,180,235),Color.argb(34,55,95,190),Color.TRANSPARENT),
            floatArrayOf(0f,.42f,1f),Shader.TileMode.CLAMP)
        paint.shader=milkyWay
        c.save(); c.rotate(-18f,w*.5f,h*.48f); c.drawOval(w*.02f,h*.28f,w*.98f,h*.68f,paint); c.restore()
        paint.shader=null

        val violet=RadialGradient(w*.20f,h*.30f,w*.42f,
            intArrayOf(Color.argb(55,100,45,205),Color.argb(12,55,30,150),Color.TRANSPARENT),
            null,Shader.TileMode.CLAMP)
        paint.shader=violet;c.drawCircle(w*.20f,h*.30f,w*.42f,paint);paint.shader=null

        val cyan=RadialGradient(w*.80f,h*.66f,w*.45f,
            intArrayOf(Color.argb(45,15,170,220),Color.argb(10,10,80,150),Color.TRANSPARENT),
            null,Shader.TileMode.CLAMP)
        paint.shader=cyan;c.drawCircle(w*.80f,h*.66f,w*.45f,paint);paint.shader=null

        for (s in stars) {
            val drift=sin(time*(.04f+s[3]*.05f)+s[1]*20f)*5f
            var x=s[0]*w+drift+rotation*.08f
            if(x<0)x+=w;if(x>w)x-=w
            val y=s[1]*h
            val twinkle=(sin(time*(1f+s[3]*2f)+s[0]*30f)+1f)*.5f
            paint.color=Color.argb((70+s[2]*70+twinkle*55).toInt().coerceIn(40,220),185,225,255)
            c.drawCircle(x,y,s[2]*(.8f+twinkle*.35f),paint)
        }
    }

    private fun drawCore(c:Canvas,w:Float,h:Float) {
        val cx=w*.5f; val cy=h*.43f
        val r=min(w,h)*.255f
        val pulse=1f+sin(time*2.0f)*.012f
        c.save()
        c.scale(pulse,pulse,cx,cy)
        c.rotate(rotation*.05f,cx,cy)

        // The existing Ax brain artwork remains the identity centerpiece.
        val targetW=r*2.55f
        val targetH=targetW*(axBrain.height.toFloat()/axBrain.width.toFloat())
        val rect=RectF(cx-targetW/2f,cy-targetH/2f,cx+targetW/2f,cy+targetH/2f)
        paint.style=Paint.Style.FILL
        paint.alpha=245
        paint.setShadowLayer(38f,0f,0f,Color.rgb(30,210,255))
        c.drawBitmap(axBrain,null,rect,paint)
        paint.clearShadowLayer();paint.alpha=255

        // Fine neural particles: restrained, crisp, and alive.
        for(i in 0..42){
            val a=i*1.53f+time*(.22f+(i%3)*.05f)
            val rr=r*(.14f+(i%9)*.06f)
            val x=cx+cos(a)*rr
            val y=cy+sin(a)*rr*.67f
            paint.color=Color.argb(150,125,235,255)
            c.drawCircle(x,y,1.0f+abs(sin(time*2.4f+i))*1.3f,paint)
        }

        // Minimal orbital trace — no flat rotating platforms.
        paint.style=Paint.Style.STROKE
        paint.strokeWidth=1.2f
        paint.color=Color.argb(55,120,220,255)
        c.drawOval(cx-r*1.08f,cy-r*.38f,cx+r*1.08f,cy+r*.38f,paint)
        c.restore()
    }

    private fun drawTopStatus(c:Canvas,w:Float) {
        text.textAlign=Paint.Align.CENTER
        text.color=Color.WHITE;text.textSize=25f
        c.drawText("HABITAT",w/2f,42f,text)
        text.textSize=11f;text.color=Color.rgb(135,225,255)
        c.drawText("AX  •  NEURAL CORE ONLINE",w/2f,61f,text)
        text.textSize=9f;text.color=Color.argb(160,210,230,255)
        c.drawText(when(tab){0->"COMMAND";1->"PROJECT MESH";2->"WORKER MESH";else->"TASK FLOW"},w/2f,78f,text)
    }

    private fun drawBottomNav(c:Canvas,w:Float,h:Float) {
        val barY=h*.88f
        paint.style=Paint.Style.FILL
        paint.color=Color.argb(165,2,10,23)
        c.drawRoundRect(w*.04f,barY,w*.96f,h*.98f,24f,24f,paint)
        paint.style=Paint.Style.STROKE;paint.strokeWidth=1f;paint.color=Color.argb(75,130,210,255)
        c.drawRoundRect(w*.04f,barY,w*.96f,h*.98f,24f,24f,paint)
        val cell=w/tabs.size
        text.textSize=10f;text.textAlign=Paint.Align.CENTER
        for(i in tabs.indices){
            text.color=if(i==tab)Color.WHITE else Color.argb(150,180,215,235)
            c.drawText(tabs[i],cell*(i+.5f),barY+34f,text)
            if(i==tab){
                paint.style=Paint.Style.FILL;paint.color=Color.argb(190,105,225,255)
                c.drawCircle(cell*(i+.5f),barY+13f,2.5f,paint)
            }
        }
    }
}