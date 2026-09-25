package com.habitat

import android.content.Context
import android.graphics.*
import android.view.MotionEvent
import android.view.View
import kotlin.math.min

class HabitatOverlay(ctx: Context) : View(ctx) {
    var onSectionChanged: ((Int) -> Unit)? = null
    private val names = arrayOf("CHAT", "WORKERS", "TASKS", "NOTIFY")
    private var selected = 0
    private var panel = false
    private val messages = mutableListOf(
        "AX  •  Neural core online.",
        "Ready. Give me a command or delegate a task."
    )
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    fun addChatMessage(who: String, msg: String) {
        messages.add("$who  •  $msg")
        if (messages.size > 12) messages.removeAt(0)
        invalidate()
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

        text(c, "HABITAT", width / 2f, height * .062f, s * .052f, Color.WHITE)
        text(c, "AX  /  NEURAL COMMAND CENTER", width / 2f, height * .098f, s * .021f, Color.rgb(105, 225, 255))

        // Status chips make the interface feel like a command console without covering the brain.
        chip(c, width * .08f, height * .125f, width * .31f, "CORE  ONLINE")
        chip(c, width * .69f, height * .125f, width * .92f, "MESH  READY")

        if (panel) drawPanel(c)

        // Raised bottom command rail; the Ax composer sits above this rail.
        val y = height * .855f
        val cell = width / 4f
        for (i in 0..3) {
            val l = cell * i + 7
            val r = cell * (i + 1) - 7
            paint.style = Paint.Style.FILL
            paint.color = if (i == selected) Color.argb(225, 10, 100, 135) else Color.argb(215, 3, 15, 29)
            c.drawRoundRect(l, y, r, y + height * .065f, 22f, 22f, paint)
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 2.5f
            paint.color = if (i == selected) Color.rgb(80, 225, 255) else Color.rgb(30, 100, 130)
            c.drawRoundRect(l, y, r, y + height * .065f, 22f, 22f, paint)
            text(c, names[i], (l + r) / 2f, y + height * .041f, s * .021f, Color.WHITE)
        }
    }

    private fun chip(c: Canvas, l: Float, top: Float, r: Float, label: String) {
        paint.style = Paint.Style.FILL
        paint.color = Color.argb(130, 3, 25, 40)
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
        paint.color = Color.argb(235, 2, 9, 23)
        c.drawRoundRect(left, top, right, bottom, 34f, 34f, paint)
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
                var yy = top + height * .16f
                for (m in messages.takeLast(6)) {
                    val whoColor = if (m.startsWith("AX")) Color.rgb(130, 235, 255) else Color.WHITE
                    text(c, m.take(58), left + 28, yy, s * .021f, whoColor, Paint.Align.LEFT)
                    yy += height * .055f
                }
                text(c, "TEXT / VOICE COMMANDS ACTIVE", width / 2f, bottom - height * .025f, s * .016f, Color.rgb(70, 190, 220))
            }
            1 -> {
                row(c, "AX", "ORCHESTRATOR", top + height * .15f, true)
                row(c, "CLAUDE", "WORKER  •  READY", top + height * .245f, false)
                row(c, "MUSE", "WORKER  •  READY", top + height * .34f, false)
                row(c, "DELEGATION", "CHANNEL  •  ONLINE", top + height * .435f, false)
            }
            2 -> {
                row(c, "BUILD HABITAT", "ACTIVE", top + height * .15f, true)
                row(c, "WORKER MESH", "READY", top + height * .245f, false)
                row(c, "DROPPILOT", "QUEUED", top + height * .34f, false)
                row(c, "AUTOMATIONS", "STANDBY", top + height * .435f, false)
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

    override fun onTouchEvent(e: MotionEvent): Boolean {
        if (e.actionMasked != MotionEvent.ACTION_UP) return true

        val navY = height * .855f
        if (e.y >= navY) {
            selected = ((e.x / (width / 4f)).toInt()).coerceIn(0, 3)
            panel = true
            onSectionChanged?.invoke(selected)
            invalidate()
            return true
        }

        // Tapping the brain/empty space closes an open command panel.
        if (panel && e.y < height * .70f) {
            panel = false
            invalidate()
            return true
        }
        return true
    }
}
