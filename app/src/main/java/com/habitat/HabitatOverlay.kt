package com.habitat

import android.content.Context
import android.graphics.*
import android.view.MotionEvent
import android.view.View
import kotlin.math.min

class HabitatOverlay(ctx: Context) : View(ctx) {
    var onSectionChanged: ((Int) -> Unit)? = null
    var onSystemCheckRun: (() -> Unit)? = null
    private val names = arrayOf("CHAT", "WORKERS", "TASKS", "NOTIFY")
    private var selected = 0
    private var panel = false
    private var missionRunning = false
    private var missionComplete = false
    private var systemCheckTaskStatus = "NOT LOADED"
    private var chatScroll = 0f
    private var touchDownY = 0f
    private var lastTouchY = 0f
    private var draggingChat = false
    private val messages = mutableListOf(
        "AX  •  Neural core online.",
        "Ready. Give me a command or delegate a task."
    )
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var animTick = 0L
    private val axBrain: Bitmap? = try {
        BitmapFactory.decodeResource(resources, R.drawable.ax_brain)
    } catch (_: Exception) {
        null
    }

    fun openChat() {
        selected = 0
        panel = true
        onSectionChanged?.invoke(0)
        invalidate()
    }

    fun addChatMessage(who: String, msg: String) {
        messages.add("$who  •  $msg")
        while (messages.size > 100) messages.removeAt(0)
        chatScroll = 0f
        invalidate()
    }

    fun setSystemCheckTaskStatus(status: String) {
        systemCheckTaskStatus = status
        invalidate()
    }

    fun setDropPilotMissionState(running: Boolean, complete: Boolean = false) {
        missionRunning = running
        missionComplete = complete
        invalidate()
    }

    fun replaceLastAxMessage(msg: String) {
        for (i in messages.indices.reversed()) {
            if (messages[i].startsWith("AX  •")) {
                messages[i] = "AX  •  $msg"
                invalidate()
                return
            }
        }
        addChatMessage("AX", msg)
    }

    private fun text(c: Canvas, value: String, x: Float, y: Float, size: Float, color: Int, align: Paint.Align = Paint.Align.CENTER) {
        paint.style = Paint.Style.FILL
        paint.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        paint.textAlign = align
        paint.textSize = size
        paint.color = color
        c.drawText(value, x, y, paint)
    }

    override fun onDraw(c: Canvas) {
        super.onDraw(c)
        val s = min(width, height).toFloat()
        drawGalaxy(c)
        text(c, "HABITAT", width / 2f, height * .060f, s * .050f, Color.WHITE)
        text(c, "AX  /  NEURAL COMMAND CENTER", width / 2f, height * .093f, s * .019f, Color.rgb(112, 236, 255))
        chip(c, width * .055f, height * .118f, width * .315f, "● CORE ONLINE")
        chip(c, width * .685f, height * .118f, width * .945f, "● MESH READY")
        drawAxBrain(c)
        drawOrbitHud(c)
        if (panel) drawPanel(c)

        val y = height * .855f
        val cell = width / 4f
        paint.style = Paint.Style.FILL
        paint.color = Color.argb(190, 4, 13, 30)
        c.drawRoundRect(8f, y - 10f, width - 8f, y + height * .078f, 30f, 30f, paint)
        for (i in 0..3) {
            val l = cell * i + 12
            val r = cell * (i + 1) - 12
            val active = i == selected
            paint.style = Paint.Style.FILL
            paint.color = if (active) Color.argb(170, 10, 105, 138) else Color.argb(70, 25, 55, 78)
            c.drawRoundRect(l, y, r, y + height * .060f, 20f, 20f, paint)
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = if (active) 2.4f else 1.2f
            paint.color = if (active) Color.rgb(90, 238, 255) else Color.argb(120, 80, 180, 210)
            c.drawRoundRect(l, y, r, y + height * .060f, 20f, 20f, paint)
            text(c, names[i], (l + r) / 2f, y + height * .038f, s * .019f, if (active) Color.WHITE else Color.rgb(150, 200, 215))
        }
        animTick = System.currentTimeMillis()
        postInvalidateDelayed(32L)
    }

    private fun drawGalaxy(c: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        val bg = LinearGradient(0f, 0f, 0f, h, Color.rgb(1, 4, 18), Color.rgb(3, 18, 38), Shader.TileMode.CLAMP)
        paint.shader = bg
        paint.style = Paint.Style.FILL
        c.drawRect(0f, 0f, w, h, paint)
        paint.shader = null
        val haze = RadialGradient(w * .52f, h * .36f, w * .65f,
            intArrayOf(Color.argb(65, 0, 180, 220), Color.argb(20, 45, 75, 150), Color.TRANSPARENT),
            floatArrayOf(0f, .48f, 1f), Shader.TileMode.CLAMP)
        paint.shader = haze
        c.drawCircle(w * .52f, h * .38f, w * .68f, paint)
        paint.shader = null
        paint.style = Paint.Style.FILL
        for (i in 0 until 95) {
            val x = ((i * 83 + 17) % 1000) / 1000f * w
            val y = ((i * 137 + 41) % 1000) / 1000f * h
            val pulse = 0.55f + 0.45f * kotlin.math.sin(animTick / 700.0 + i).toFloat()
            paint.alpha = (45 + pulse * 130).toInt()
            c.drawCircle(x, y, if (i % 9 == 0) 2.0f else 1.0f, paint)
        }
        paint.alpha = 255
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1f
        paint.color = Color.argb(55, 65, 220, 255)
        c.drawOval(RectF(-w * .25f, h * .63f, w * 1.25f, h * 1.13f), paint)
        c.drawOval(RectF(-w * .10f, h * .68f, w * 1.10f, h * 1.04f), paint)
    }

    private fun drawAxBrain(c: Canvas) {
        val cx = width / 2f
        val cy = height * .405f
        val radius = width * .34f
        val pulse = 1f + kotlin.math.sin(animTick / 520.0).toFloat() * .025f
        paint.style = Paint.Style.FILL
        paint.shader = RadialGradient(cx, cy, radius * 1.18f,
            intArrayOf(Color.argb(110, 0, 220, 255), Color.argb(38, 0, 150, 220), Color.TRANSPARENT),
            floatArrayOf(0f, .52f, 1f), Shader.TileMode.CLAMP)
        c.drawCircle(cx, cy, radius * pulse * 1.18f, paint)
        paint.shader = null
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 2.2f
        paint.color = Color.argb(120, 75, 235, 255)
        val orbit = radius * 1.02f
        c.save()
        c.rotate((animTick / 35L % 360L).toFloat(), cx, cy)
        c.drawOval(RectF(cx - orbit, cy - orbit * .34f, cx + orbit, cy + orbit * .34f), paint)
        c.restore()
        c.save()
        c.rotate((-animTick / 55L % 360L).toFloat(), cx, cy)
        paint.color = Color.argb(75, 110, 170, 255)
        c.drawOval(RectF(cx - orbit * .86f, cy - orbit * .22f, cx + orbit * .86f, cy + orbit * .22f), paint)
        c.restore()
        val bitmap = axBrain ?: return
        val brainW = width * .70f
        val brainH = brainW * (bitmap.height.toFloat() / bitmap.width.toFloat())
        val rect = RectF(cx - brainW / 2f, cy - brainH / 2f, cx + brainW / 2f, cy + brainH / 2f)
        paint.style = Paint.Style.FILL
        paint.alpha = 205
        paint.setShadowLayer(34f, 0f, 0f, Color.rgb(20, 225, 255))
        c.drawBitmap(bitmap, null, rect, paint)
        paint.clearShadowLayer()
        paint.alpha = 255
        val scan = ((animTick / 7L) % (brainH.toLong().coerceAtLeast(1L))).toFloat()
        paint.color = Color.argb(65, 100, 245, 255)
        paint.strokeWidth = 2f
        c.drawLine(rect.left + 12f, rect.top + scan, rect.right - 12f, rect.top + scan, paint)
    }

    private fun drawOrbitHud(c: Canvas) {
        val cx = width / 2f
        val cy = height * .405f
        val r = width * .405f
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1.3f
        paint.color = Color.argb(70, 100, 230, 255)
        c.drawCircle(cx, cy, r, paint)
        c.drawCircle(cx, cy, r * .92f, paint)
        val sweep = (animTick / 8L % 360L).toFloat()
        paint.color = Color.argb(170, 70, 240, 255)
        c.drawArc(RectF(cx-r, cy-r, cx+r, cy+r), sweep, 28f, false, paint)
        text(c, "AX CORE", cx, cy + r + 25f, min(width, height) * .014f, Color.rgb(105, 225, 245))
        text(c, "NEURAL LINK  //  STABLE", cx, cy + r + 45f, min(width, height) * .011f, Color.argb(180, 130, 205, 220))
    }

    private fun chip(c: Canvas, l: Float, top: Float, r: Float, label: String) {
        paint.style = Paint.Style.FILL
        paint.color = Color.argb(155, 4, 20, 38)
        c.drawRoundRect(l, top, r, top + height * .036f, 18f, 18f, paint)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1.5f
        paint.color = Color.argb(150, 75, 215, 255)
        c.drawRoundRect(l, top, r, top + height * .036f, 18f, 18f, paint)
        text(c, label, (l + r) / 2f, top + height * .025f, min(width, height) * .014f, Color.rgb(140, 225, 245))
    }

    private fun drawPanel(c: Canvas) {
        val s = min(width, height).toFloat()
        val left = width * .045f
        val right = width * .955f
        val top = height * .18f
        val bottom = height * .70f

        paint.style = Paint.Style.FILL
        paint.color = Color.argb(220, 3, 10, 26)
        paint.setShadowLayer(24f, 0f, 8f, Color.argb(100, 0, 190, 240))
        c.drawRoundRect(left, top, right, bottom, 34f, 34f, paint)
        paint.clearShadowLayer()
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 2.5f
        paint.color = Color.argb(190, 75, 215, 255)
        c.drawRoundRect(left, top, right, bottom, 34f, 34f, paint)

        text(c, names[selected], width / 2f, top + height * .075f, s * .038f, Color.WHITE)
        paint.color = Color.argb(80, 100, 225, 255)
        paint.strokeWidth = 1.5f
        c.drawLine(left + 24, top + height * .10f, right - 24, top + height * .10f, paint)

        when (selected) {
            0 -> {
                val contentLeft = left + 28f
                val contentRight = right - 28f
                val contentWidth = contentRight - contentLeft
                val lineHeight = height * .032f
                var yy = top + height * .15f - chatScroll

                for (m in messages) {
                    val whoColor = if (m.startsWith("AX")) Color.rgb(130, 235, 255) else Color.WHITE
                    val wrapped = wrapText(m, contentWidth, s * .018f)
                    for (line in wrapped) {
                        if (yy >= top + height * .115f && yy <= bottom - height * .055f) {
                            text(c, line, contentLeft, yy, s * .018f, whoColor, Paint.Align.LEFT)
                        }
                        yy += lineHeight
                    }
                    yy += height * .010f
                }

                val totalContentHeight = yy - (top + height * .15f) + chatScroll
                val viewportHeight = (bottom - top) - height * .19f
                val maxScroll = maxOf(0f, totalContentHeight - viewportHeight)
                chatScroll = chatScroll.coerceIn(0f, maxScroll)

                if (maxScroll > 0f) {
                    text(c, "SWIPE TO SCROLL", right - 28f, bottom - height * .025f,
                        s * .012f, Color.rgb(70, 190, 220), Paint.Align.RIGHT)
                }
                text(c, if (missionRunning) "AX EXECUTION LOOP  •  WORKERS ACTIVE" else "TEXT / VOICE COMMANDS ACTIVE",
                    width / 2f, bottom - height * .025f, s * .015f, Color.rgb(70, 190, 220))
            }
            1 -> {
                row(c, "AX", if (missionRunning) "ORCHESTRATOR  •  RUNNING" else "ORCHESTRATOR  •  READY", top + height * .15f, true)
                row(c, "PRODUCT SCOUT", if (missionRunning) "WORKER  •  RUNNING" else "WORKER  •  READY", top + height * .245f, missionRunning)
                row(c, "LISTING OPT", if (missionRunning) "WORKER  •  RUNNING" else "WORKER  •  READY", top + height * .34f, missionRunning)
                row(c, "GROWTH OPS", if (missionComplete) "WORKER  •  COMPLETE" else if (missionRunning) "WORKER  •  RUNNING" else "WORKER  •  READY", top + height * .435f, missionComplete || missionRunning)
            }
            2 -> {
                row(c, "SYSTEM CHECK", systemCheckTaskStatus, top + height * .15f, systemCheckTaskStatus != "NOT LOADED")
                val runTop = top + height * .235f
                paint.style = Paint.Style.FILL
                paint.color = Color.argb(185, 8, 112, 145)
                c.drawRoundRect(width * .22f, runTop, width * .78f, runTop + height * .065f, 20f, 20f, paint)
                paint.style = Paint.Style.STROKE
                paint.strokeWidth = 2f
                paint.color = Color.rgb(90, 238, 255)
                c.drawRoundRect(width * .22f, runTop, width * .78f, runTop + height * .065f, 20f, 20f, paint)
                text(c, if (systemCheckTaskStatus.contains("RUNNING")) "SYSTEM CHECK  •  RUNNING" else "▶  RUN SYSTEM CHECK",
                    width / 2f, runTop + height * .041f, s * .020f, Color.WHITE)
                row(c, "DROPPILOT", if (missionRunning) "MISSION  •  RUNNING" else if (missionComplete) "MISSION  •  COMPLETE" else "MISSION  •  READY", top + height * .335f, missionRunning || missionComplete)
                row(c, "PRODUCT SCOUT", if (missionRunning) "ANALYZING" else "READY", top + height * .43f, missionRunning)
                row(c, "LISTING OPT", if (missionRunning) "AUDITING" else "READY", top + height * .525f, missionRunning)
            }
            3 -> {
                row(c, "HABITAT CORE", "ONLINE", top + height * .15f, true)
                row(c, "3D NEURAL RENDERER", "ONLINE", top + height * .245f, false)
                row(c, "VOICE INPUT", "READY", top + height * .34f, false)
                row(c, "ALERTS", "NONE", top + height * .435f, false)
            }
        }
    }

    private fun row(c: Canvas, title: String, status: String, y: Float, active: Boolean) {
        val l = width * .085f
        val r = width * .915f
        paint.style = Paint.Style.FILL
        paint.color = if (active) Color.argb(115, 9, 98, 132) else Color.argb(85, 7, 37, 54)
        c.drawRoundRect(l, y, r, y + height * .07f, 18f, 18f, paint)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1.5f
        paint.color = Color.argb(130, 65, 190, 225)
        c.drawRoundRect(l, y, r, y + height * .07f, 18f, 18f, paint)
        text(c, title, l + 18, y + height * .031f, min(width, height) * .020f, Color.WHITE, Paint.Align.LEFT)
        text(c, status, r - 18, y + height * .031f, min(width, height) * .017f, Color.rgb(110, 225, 245), Paint.Align.RIGHT)
    }

    private fun wrapText(value: String, maxWidth: Float, size: Float): List<String> {
        paint.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        paint.textSize = size
        val result = mutableListOf<String>()
        for (paragraph in value.replace("\r", "").split("\n")) {
            var line = ""
            for (word in paragraph.split(" ")) {
                val candidate = if (line.isEmpty()) word else "$line $word"
                if (paint.measureText(candidate) <= maxWidth || line.isEmpty()) {
                    line = candidate
                } else {
                    result.add(line)
                    line = word
                }
            }
            if (line.isNotEmpty()) result.add(line)
        }
        return if (result.isEmpty()) listOf("") else result
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        val navY = height * .855f
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                touchDownY = e.y
                lastTouchY = e.y
                draggingChat = false
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (panel && selected == 0 && e.y < height * .70f) {
                    val dy = lastTouchY - e.y
                    if (kotlin.math.abs(e.y - touchDownY) > 8f) draggingChat = true
                    chatScroll += dy
                    lastTouchY = e.y
                    invalidate()
                    return true
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                if (draggingChat) {
                    draggingChat = false
                    return true
                }
            }
        }

        if (e.actionMasked != MotionEvent.ACTION_UP) return true
        if (e.y >= navY) {
            selected = ((e.x / (width / 4f)).toInt()).coerceIn(0, 3)
            panel = true
            onSectionChanged?.invoke(selected)
            invalidate()
            return true
        }
        if (panel && selected == 2) {
            val panelTop = height * .18f
            val runTop = panelTop + height * .235f
            val runBottom = runTop + height * .065f
            if (e.y >= runTop && e.y <= runBottom && e.x >= width * .22f && e.x <= width * .78f) {
                systemCheckTaskStatus = "RUNNING  •  LIVE"
                invalidate()
                onSystemCheckRun?.invoke()
                return true
            }
            if (e.y >= panelTop && e.y < height * .70f) return true
        }
        if (panel && e.y < height * .70f) {
            panel = false
            invalidate()
            return true
        }
        return true
    }
}
