package com.habitat

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Opt-in Accessibility service.
 *
 * It exists so Habitat can (a) read what is on screen and (b) perform one explicitly owner-approved
 * action at a time. It never runs a search loop by itself, never reads password fields, and never
 * uses the accessibility connection to bypass Android consent dialogs: taps land where the owner
 * approved them, and the system can always override them.
 *
 * Android shows this service in Settings → Accessibility and the owner can revoke it at any time.
 */
class HabitatAccessibilityService : AccessibilityService() {

    companion object {
        private const val MAX_NODES = 200
        private const val MAX_DEPTH = 12
        private const val MAX_TEXT = 160

        @Volatile
        private var connected: HabitatAccessibilityService? = null

        val instance: HabitatAccessibilityService?
            get() = connected

        fun isEnabled(context: android.content.Context): Boolean {
            if (connected != null) return true
            val enabled = android.provider.Settings.Secure.getString(
                context.contentResolver,
                android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ).orEmpty()
            return enabled.split(':').any { it.equals(context.packageName + "/" + HabitatAccessibilityService::class.java.name, ignoreCase = true) }
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        connected = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Deliberately passive: reading happens on request, never on every event.
    }

    override fun onInterrupt() {
        // Nothing is running in the background.
    }

    override fun onDestroy() {
        if (connected === this) connected = null
        super.onDestroy()
    }

    /** Bounded, text-only snapshot of the current screen. No screenshots and no password fields. */
    fun snapshot(): JSONObject {
        val metrics = resources.displayMetrics
        val root = rootInActiveWindow
        val nodes = JSONArray()
        var count = 0
        if (root != null) {
            count = collect(root, nodes, 0, count)
        }
        val result = JSONObject()
            .put("screen", JSONObject().put("width", metrics.widthPixels).put("height", metrics.heightPixels))
            .put("packageName", root?.packageName?.toString() ?: "")
            .put("nodeCount", count)
            .put("nodes", nodes)
        return result
    }

    private fun collect(node: AccessibilityNodeInfo, out: JSONArray, depth: Int, count: Int): Int {
        if (count >= MAX_NODES || depth > MAX_DEPTH) return count
        var total = count
        val text = node.text?.toString().orEmpty().trim()
        val description = node.contentDescription?.toString().orEmpty().trim()
        val className = node.className?.toString().orEmpty()
        val viewId = node.viewIdResourceName.orEmpty()
        // A password field is reported as present but never with its content.
        val password = node.isPassword
        val editable = node.isEditable
        if (text.isNotEmpty() || description.isNotEmpty() || password) {
            val bounds = Rect()
            node.getBoundsInScreen(bounds)
            val entry = JSONObject()
                .put("className", className.take(80))
                .put("viewId", viewId.take(120))
                .put("text", if (password) "" else text.take(MAX_TEXT))
                .put("description", if (password) "" else description.take(MAX_TEXT))
                .put("editable", editable)
                .put("password", password)
                .put("clickable", node.isClickable)
                .put("bounds", JSONObject().put("left", bounds.left).put("top", bounds.top).put("right", bounds.right).put("bottom", bounds.bottom))
            out.put(entry)
            total += 1
        }
        for (index in 0 until node.childCount) {
            if (total >= MAX_NODES) break
            val child = node.getChild(index) ?: continue
            total = collect(child, out, depth + 1, total)
        }
        return total
    }

    /** Permille coordinates (0–10000) map onto the current display regardless of resolution. */
    fun tap(permilleX: Int, permilleY: Int): Boolean {
        val metrics = resources.displayMetrics
        val x = (permilleX.coerceIn(0, 10000) / 10000f) * metrics.widthPixels
        val y = (permilleY.coerceIn(0, 10000) / 10000f) * metrics.heightPixels
        val path = Path().apply { moveTo(x, y) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 50))
            .build()
        return dispatchGesture(gesture, null, null)
    }

    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Int): Boolean {
        val metrics = resources.displayMetrics
        fun x(value: Int) = (value.coerceIn(0, 10000) / 10000f) * metrics.widthPixels
        fun y(value: Int) = (value.coerceIn(0, 10000) / 10000f) * metrics.heightPixels
        val path = Path().apply {
            moveTo(x(x1), y(y1))
            lineTo(x(x2), y(y2))
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs.toLong().coerceIn(100L, 2000L)))
            .build()
        return dispatchGesture(gesture, null, null)
    }

    /** Sets text in the focused editable field. Password fields are refused, not filled. */
    fun type(text: String): Boolean {
        val focused = findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
        if (focused.isPassword) return false
        if (!focused.isEditable) return false
        val arguments = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
    }

    fun key(name: String): Boolean = when (name) {
        "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
        "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
        "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
        "enter" -> sendImeEnter()
        else -> false
    }

    private fun sendImeEnter(): Boolean {
        if (Build.VERSION.SDK_INT < 30) return false
        val focused = findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
        return focused.performAction(AccessibilityNodeInfo.ACTION_IME_ENTER)
    }

    /**
     * One JPEG frame through the accessibility screenshot API (Android 11+). This uses the same
     * owner-granted accessibility connection, so there is no second screen-capture consent dialog
     * and no MediaProjection session left running.
     */
    fun captureJpegBase64(onResult: (String?) -> Unit) {
        if (Build.VERSION.SDK_INT < 30) {
            onResult(null)
            return
        }
        takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : AccessibilityService.TakeScreenshotCallback {
            override fun onSuccess(screenshot: AccessibilityService.ScreenshotResult) {
                try {
                    val bitmap = Bitmap.wrapHardwareBuffer(screenshot.hardwareBuffer, screenshot.colorSpace)
                    if (bitmap == null) {
                        onResult(null)
                        return
                    }
                    val scaled = if (bitmap.width > 1080) {
                        val height = (bitmap.height.toFloat() * 1080f / bitmap.width).toInt().coerceAtLeast(1)
                        Bitmap.createScaledBitmap(bitmap, 1080, height, true)
                    } else bitmap
                    val bytes = ByteArrayOutputStream()
                    scaled.compress(Bitmap.CompressFormat.JPEG, 72, bytes)
                    if (scaled !== bitmap) scaled.recycle()
                    bitmap.recycle()
                    onResult(Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
                } catch (_: Throwable) {
                    onResult(null)
                } finally {
                    screenshot.hardwareBuffer.close()
                }
            }

            override fun onFailure(errorCode: Int) {
                onResult(null)
            }
        })
    }
}
