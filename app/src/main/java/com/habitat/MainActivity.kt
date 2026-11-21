package com.habitat

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognizerIntent
import android.view.Gravity
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.widget.*
import org.json.JSONObject
import android.graphics.Color
import java.util.Locale

class MainActivity : Activity() {
    companion object { private const val STATE_PAIRING_DIALOG = "pairing_dialog_open" }

    private lateinit var input: EditText
    private lateinit var ui: HabitatOverlay
    private lateinit var brain: BrainAdapter
    private lateinit var deviceBridge: AndroidDeviceBridge
    private var deviceBridgeButton: Button? = null
    private var pairingDialog: AlertDialog? = null
    private var pairingStatusView: TextView? = null
    private var pairingButton: Button? = null
    private var pairingDiagnosticsView: TextView? = null
    private val voiceCode = 700
    private var lastTaskId: String? = null
    private val taskPrefs by lazy { getSharedPreferences("habitat_tasks", MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        HabitatCrashHandler.install(this)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        window.setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN)
        window.navigationBarColor = Color.BLACK
        deviceBridge = AndroidDeviceBridge(this) { status ->
            runOnUiThread { onBridgeStatus(status) }
        }
        brain = BrainAdapter(this) {
            deviceBridge.currentToken()?.let { token -> deviceBridge.deviceId to token }
        }
        lastTaskId = taskPrefs.getString("live_system_check_task_id", null)
        deviceBridge.recordLifecycle("MainActivity created")

        val root = FrameLayout(this)
        val space = Habitat3DSurface(this)
        ui = HabitatOverlay(this)
        root.addView(space, FrameLayout.LayoutParams(-1, -1))
        root.addView(ui, FrameLayout.LayoutParams(-1, -1))

        val composer = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(12, 8, 12, 8)
            setBackgroundColor(Color.argb(242, 2, 12, 24))
            elevation = 18f
        }

        input = EditText(this).apply {
            hint = "Message Ax…"
            setSingleLine(false)
            minLines = 1
            maxLines = 5
            gravity = Gravity.CENTER_VERTICAL
            setHorizontallyScrolling(false)
            filters = arrayOf(android.text.InputFilter.LengthFilter(12000))
            setTextColor(Color.WHITE)
            setHintTextColor(Color.rgb(110, 190, 215))
            textSize = 17f
            setPadding(18, 0, 12, 0)
            setBackgroundColor(Color.argb(225, 7, 29, 48))
        }
        composer.addView(input, LinearLayout.LayoutParams(0, 82, 1f))

        val voice = Button(this).apply {
            text = "◉"
            textSize = 18f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(7, 79, 108))
            isAllCaps = false
        }
        composer.addView(voice, LinearLayout.LayoutParams(64, 82).apply { leftMargin = 8 })

        val send = Button(this).apply {
            text = "➤"
            textSize = 22f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(8, 122, 154))
            isAllCaps = false
        }
        composer.addView(send, LinearLayout.LayoutParams(70, 82).apply { leftMargin = 8 })
        val tiktok = Button(this).apply { text = "TT"; textSize = 15f; setTextColor(Color.WHITE); setBackgroundColor(Color.rgb(28, 28, 36)); isAllCaps = false; setOnClickListener { showTikTokPublisherDialog() } }
        composer.addView(tiktok, LinearLayout.LayoutParams(58, 82).apply { leftMargin = 8 })
        val bridgeButton = Button(this).apply {
            text = when (deviceBridge.linkState()) {
                AndroidDeviceBridge.LinkState.LIVE -> "LIVE"
                AndroidDeviceBridge.LinkState.PAIRED_UNVERIFIED -> "VERIFY"
                AndroidDeviceBridge.LinkState.REVOKED -> "REVOKED"
                AndroidDeviceBridge.LinkState.UNPAIRED -> "LINK"
            }
            textSize = 13f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(5, 92, 105))
            isAllCaps = false
            setOnClickListener { showDeviceBridgeDialog() }
        }
        deviceBridgeButton = bridgeButton
        composer.addView(bridgeButton, LinearLayout.LayoutParams(62, 82).apply { leftMargin = 8 })

        // The command composer lives above the Samsung navigation area and above
        // the bottom navigation rail instead of being pinned to the screen bottom.
        val cp = FrameLayout.LayoutParams(-1, 104, Gravity.TOP)
        cp.setMargins(14, 0, 14, 0)
        root.addView(composer, cp)

        fun positionComposer() {
            val usable = root.height
            if (usable <= 0) return
            val lp = composer.layoutParams as FrameLayout.LayoutParams
            lp.topMargin = (usable * 0.695f).toInt()
            composer.layoutParams = lp
        }
        root.post { positionComposer() }
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> positionComposer() }

        fun setBusy(busy: Boolean) {
            input.isEnabled = !busy
            send.isEnabled = !busy
            voice.isEnabled = !busy
            send.text = if (busy) "…" else "➤"
        }

        fun submit() {
            val message = input.text.toString().trim()
            if (message.isEmpty() || !input.isEnabled) return
            input.setText("")
            ui.openChat()
            ui.addChatMessage("YOU", message)
            ui.addChatMessage("AX", "Thinking…")
            setBusy(true)

            val mission = message.lowercase(Locale.US)
            val isEndToEndTest = mission.contains("ax end-to-end test") ||
                (mission.contains("create a test task") && mission.contains("verify backend health") && mission.contains("model worker"))

            if (isEndToEndTest) {
                ui.addChatMessage("AX", "Running the live end-to-end Habitat test: task creation → backend health → model worker → result return…")
                brain.runEndToEndTest { result ->
                    runOnUiThread {
                        setBusy(false)
                        if (result.state == BrainAdapter.State.CONNECTED) {
                            ui.replaceLastAxMessage(result.text)
                        } else {
                            ui.replaceLastAxMessage("End-to-end test failed: " + result.detail)
                        }
                    }
                }
                return
            }

            val isDropPilotMission = mission.contains("run droppilot") ||
                mission.contains("drop pilot mission") ||
                mission.startsWith("droppilot:")
            val isViceCityMission = mission.contains("run vice city") ||
                mission.contains("vice city files") ||
                mission.startsWith("vicecity:")


            // A complete System Check command must reach the live brain orchestrator.
            // The backend owns the real check lifecycle: task creation, QA-worker delegation,
            // execution, verification, and the PASS/FAIL report. Do this before the
            // create-only shortcut so a command that contains the word "create" does not
            // stop at "Status:".
            // Route every compound System Check request to the live brain. The
            // previous keyword gate was too permissive about which word combinations
            // counted as "full", and runtime testing showed a full request could still
            // fall through to the create-only task shortcut. A bare/simple create
            // command is the only case that should use the task shortcut.
            val simpleCreateSystemCheck = Regex(
                """^(create|make|start|load)(\s+(a|the))?\s+system\s+check(\s+task)?$"""
            ).matches(mission.trim())

            val isFullSystemCheck =
                mission.contains("system check") && !simpleCreateSystemCheck

            val isCreateSystemCheck =
                simpleCreateSystemCheck

            val isDelegateSystemCheck = false

            if (isFullSystemCheck) {
                brain.send(message) { result ->
                    runOnUiThread {
                        setBusy(false)
                        when (result.state) {
                            BrainAdapter.State.CONNECTED -> {
                                ui.replaceLastAxMessage(result.text)
                            }
                            BrainAdapter.State.ERROR -> {
                                ui.replaceLastAxMessage("System Check failed: " + result.detail)
                            }
                            BrainAdapter.State.DISCONNECTED -> {
                                ui.replaceLastAxMessage("System Check brain disconnected.")
                            }
                            BrainAdapter.State.CONNECTING -> Unit
                        }
                    }
                }
            } else if (isCreateSystemCheck) {
                brain.createTask(
                    "System Check",
                    "Verify Habitat backend connectivity and execute a real QA worker check. Do not claim Android device access unless confirmed."
                ) { result ->
                    runOnUiThread {
                        setBusy(false)
                        if (result.state == BrainAdapter.State.CONNECTED) {
                            try {
                                val task = JSONObject(result.text)
                                lastTaskId = task.optString("id", "")
                                if (lastTaskId.isNullOrBlank()) {
                                    ui.replaceLastAxMessage("System Check was created but no real task ID was returned. I will not treat it as loaded.")
                                    return@runOnUiThread
                                }
                                taskPrefs.edit().putString("live_system_check_task_id", lastTaskId).apply()
                                ui.replaceLastAxMessage(
                                    "System Check created in the real Habitat task service.\n" +
                                    "Status: " + task.optString("status", "planned") + "\n" +
                                    "Task ID: " + task.optString("id", "unknown") + "\n" +
                                    "Created: " + task.optString("createdAt", "unknown")
                                )
                            } catch (_: Exception) {
                                ui.replaceLastAxMessage("System Check created, but the task record could not be displayed.")
                            }
                        } else {
                            ui.replaceLastAxMessage("Task service failed: " + result.detail)
                        }
                    }
                }
            } else if (isDelegateSystemCheck) {
                val taskId = lastTaskId
                if (taskId.isNullOrBlank()) {
                    ui.replaceLastAxMessage("Recovering the live System Check task from Habitat…")
                    brain.findLatestSystemCheck { recovered ->
                        runOnUiThread {
                            if (recovered.state != BrainAdapter.State.CONNECTED) {
                                setBusy(false)
                                ui.replaceLastAxMessage("No live System Check task exists on the Habitat task service. Create it once, then retry.")
                                return@runOnUiThread
                            }
                            try {
                                val task = JSONObject(recovered.text)
                                val recoveredId = task.optString("id", "")
                                if (recoveredId.isBlank()) throw IllegalStateException("Recovered task has no ID")
                                lastTaskId = recoveredId
                                taskPrefs.edit().putString("live_system_check_task_id", recoveredId).apply()
                                ui.replaceLastAxMessage("Recovered System Check " + recoveredId + ". Dispatching the real Habitat QA worker…")
                                brain.delegateTask(recoveredId) { result ->
                                    runOnUiThread {
                                        setBusy(false)
                                        if (result.state == BrainAdapter.State.CONNECTED) ui.replaceLastAxMessage(result.text)
                                        else ui.replaceLastAxMessage("Worker execution failed: " + result.detail)
                                    }
                                }
                            } catch (e: Exception) {
                                setBusy(false)
                                ui.replaceLastAxMessage("System Check recovery failed: " + (e.message ?: "invalid task record"))
                            }
                        }
                    }
                } else {
                    ui.replaceLastAxMessage("Dispatching the real Habitat QA worker…")
                    brain.delegateTask(taskId) { result ->
                        runOnUiThread {
                            setBusy(false)
                            if (result.state == BrainAdapter.State.CONNECTED) {
                                ui.replaceLastAxMessage(result.text)
                            } else {
                                ui.replaceLastAxMessage("Worker execution failed: " + result.detail)
                            }
                        }
                    }
                }
            } else if (isViceCityMission) {
                ui.addChatMessage("AX", "Dispatching Topic Scout + Script Editor + Channel Operator…")
                val channelContext = JSONObject().apply {
                    put("channel", "Vice City Files")
                    put("handle", "@ViceCityFilesYT")
                    put("format", "16:9 photo/video")
                    put("editing", "CapCut")
                    put("voice", "calm, gentle, smooth TTS")
                    put("introSeconds", 7)
                    put("goal", "repeatable YouTube/TikTok content pipeline")
                }
                brain.sendViceCity(message, channelContext) { result ->
                    runOnUiThread {
                        setBusy(false)
                        when (result.state) {
                            BrainAdapter.State.CONNECTED -> ui.replaceLastAxMessage(result.text)
                            BrainAdapter.State.ERROR -> ui.replaceLastAxMessage("Vice City mission failed: " + result.detail)
                            BrainAdapter.State.DISCONNECTED -> ui.replaceLastAxMessage("Vice City operator disconnected.")
                            BrainAdapter.State.CONNECTING -> Unit
                        }
                    }
                }
            } else if (isDropPilotMission) {
                ui.setDropPilotMissionState(true)
                ui.addChatMessage("AX", "Dispatching Product Scout + Listing Optimizer + Growth Operator…")
                val storeContext = JSONObject().apply {
                    put("store", "Stevvex")
                    put("platform", "Shopify Basic + TikTok Shop US")
                    put("orders", 0)
                    put("activeProducts", 1)
                    put("currentProduct", "Car Seat Gap Organizer / Storage Pocket")
                    put("currentPrice", 21.99)
                    put("compareAtPrice", 45.00)
                    put("supplierMarginPercent", 40)
                    put("creatorCommissionPercent", 14.5)
                    put("shipsFromUS", true)
                    put("inventory", "high")
                    put("goal", "first sale today, then repeatable daily sales")
                }
                brain.sendDropPilot(message, storeContext) { result ->
                    runOnUiThread {
                        setBusy(false)
                        when (result.state) {
                            BrainAdapter.State.CONNECTED -> {
                                ui.setDropPilotMissionState(false, true)
                                ui.replaceLastAxMessage(result.text)
                            }
                            BrainAdapter.State.ERROR -> {
                                ui.setDropPilotMissionState(false, false)
                                ui.replaceLastAxMessage("DropPilot mission failed: " + result.detail)
                            }
                            BrainAdapter.State.DISCONNECTED -> {
                                ui.setDropPilotMissionState(false, false)
                                ui.replaceLastAxMessage("DropPilot brain disconnected.")
                            }
                            BrainAdapter.State.CONNECTING -> Unit
                        }
                    }
                }
            } else {
                brain.send(message) { result ->
                    runOnUiThread {
                        setBusy(false)
                        when (result.state) {
                            BrainAdapter.State.CONNECTED -> ui.replaceLastAxMessage(result.text)
                            BrainAdapter.State.ERROR -> ui.replaceLastAxMessage("I couldn't reach the Habitat brain. " + result.detail)
                            BrainAdapter.State.DISCONNECTED -> ui.replaceLastAxMessage("Habitat brain disconnected.")
                            BrainAdapter.State.CONNECTING -> Unit
                        }
                    }
                }
            }
        }

        send.setOnClickListener { submit() }
        input.setOnEditorActionListener { _, _, _ -> submit(); true }
        voice.setOnClickListener { startVoice() }

        ui.onSectionChanged = { section ->
            space.setMode(section)
            composer.visibility = if (section == 0) View.VISIBLE else View.GONE
        }

        ui.onSystemCheckRun = {
            val taskId = lastTaskId
            if (taskId.isNullOrBlank()) {
                ui.setSystemCheckTaskStatus("RECOVERING…")
                brain.findLatestSystemCheck { recovered ->
                    runOnUiThread {
                        if (recovered.state != BrainAdapter.State.CONNECTED) {
                            ui.setSystemCheckTaskStatus("CREATING  •  FRESH TASK")
                            ui.addChatMessage("AX", "No live System Check exists. Creating a fresh task now…")
                            brain.createTask(
                                "System Check",
                                "Verify Habitat backend connectivity and execute a real QA worker check. Do not claim Android device access unless confirmed."
                            ) { created ->
                                runOnUiThread {
                                    if (created.state != BrainAdapter.State.CONNECTED) {
                                        ui.setSystemCheckTaskStatus("FAILED  •  TASK CREATE")
                                        ui.addChatMessage("AX", "System Check task creation failed: " + created.detail)
                                        return@runOnUiThread
                                    }
                                    try {
                                        val task = JSONObject(created.text)
                                        val freshId = task.optString("id", "")
                                        if (freshId.isBlank()) throw IllegalStateException("fresh task has no ID")
                                        lastTaskId = freshId
                                        taskPrefs.edit().putString("live_system_check_task_id", freshId).apply()
                                        runSystemCheck(freshId)
                                    } catch (_: Exception) {
                                        ui.setSystemCheckTaskStatus("FAILED  •  INVALID TASK")
                                        ui.addChatMessage("AX", "Fresh System Check task was created but has no usable ID.")
                                    }
                                }
                            }
                            return@runOnUiThread
                        }
                        try {
                            val task = JSONObject(recovered.text)
                            val recoveredId = task.optString("id", "")
                            if (recoveredId.isBlank()) throw IllegalStateException("missing task id")
                            lastTaskId = recoveredId
                            taskPrefs.edit().putString("live_system_check_task_id", recoveredId).apply()
                            runSystemCheck(recoveredId)
                        } catch (e: Exception) {
                            ui.setSystemCheckTaskStatus("ERROR  •  INVALID TASK")
                            ui.addChatMessage("AX", "System Check recovery failed: " + (e.message ?: "invalid task"))
                        }
                    }
                }
            } else {
                runSystemCheck(taskId)
            }
        }

        setContentView(root)
        // The authenticated AndroidDeviceBridge owns heartbeat and command polling after pairing.
        // Do not post the legacy unauthenticated BrainAdapter heartbeat: it used a different device
        // id, could never prove the paired device was online, and produced false VERIFIED messages.
        if (deviceBridge.isConfigured()) {
            deviceBridge.start()
            DeviceBridgeScheduler.schedule(this)
        }
        ensureSystemCheckTask()
        if (savedInstanceState?.getBoolean(STATE_PAIRING_DIALOG, false) == true) {
            // The activity was recreated while pairing was open. Restore the dialog instead of
            // abandoning the user mid-pairing.
            root.post { showDeviceBridgeDialog() }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean(STATE_PAIRING_DIALOG, pairingDialog?.isShowing == true)
        super.onSaveInstanceState(outState)
    }

    private fun diagnosticsReport(): String {
        val lines = deviceBridge.diagnosticsLines()
        return buildString {
            append("DIAGNOSTICS\n")
            append("Endpoint: ")
            append(deviceBridge.baseUrl)
            append("\nLink: ")
            append(deviceBridge.linkState().name)
            append("\nConfirmed: ")
            append(
                if (deviceBridge.lastConfirmedAt() > 0L) {
                    java.text.SimpleDateFormat("HH:mm:ss", Locale.US).format(java.util.Date(deviceBridge.lastConfirmedAt()))
                } else "never"
            )
            append("\n")
            if (lines.isEmpty()) append("No events recorded.")
            else append(lines.joinToString("\n"))
        }
    }

    private fun updateBridgeButton() {
        deviceBridgeButton?.text = when (deviceBridge.linkState()) {
            AndroidDeviceBridge.LinkState.LIVE -> "LIVE"
            AndroidDeviceBridge.LinkState.PAIRED_UNVERIFIED -> "VERIFY"
            AndroidDeviceBridge.LinkState.REVOKED -> "REVOKED"
            AndroidDeviceBridge.LinkState.UNPAIRED -> "LINK"
        }
    }

    private fun onBridgeStatus(status: String) {
        updateBridgeButton()
        val dialog = pairingDialog
        if (dialog != null && dialog.isShowing) {
            try {
                when (deviceBridge.linkState()) {
                    AndroidDeviceBridge.LinkState.LIVE -> {
                        pairingStatusView?.text = "Ax authenticated this phone. Link is live."
                        deviceBridge.recordLifecycle("pairing confirmed by Ax")
                        dialog.dismiss()
                        Toast.makeText(this, "Phone linked and authenticated by Ax.", Toast.LENGTH_LONG).show()
                    }
                    AndroidDeviceBridge.LinkState.REVOKED -> {
                        pairingStatusView?.setTextColor(Color.rgb(180, 40, 40))
                        pairingStatusView?.text = "Ax revoked this phone's link. Pair again with a fresh code."
                        pairingButton?.isEnabled = true
                        pairingButton?.text = "Pair phone"
                    }
                    else -> pairingStatusView?.text = status
                }
                pairingDiagnosticsView?.text = diagnosticsReport()
            } catch (_: Throwable) {
                // A recycled dialog view must never crash the polling callback.
            }
        }
        if (status.contains("command completed")) {
            Toast.makeText(this, status, Toast.LENGTH_SHORT).show()
        }
    }

    private fun runSystemCheck(taskId: String) {
        ui.setSystemCheckTaskStatus("RUNNING  •  AWAITING WORKER")
        brain.delegateTask(taskId) { result ->
            runOnUiThread {
                if (result.state == BrainAdapter.State.CONNECTED) {
                    // The backend's canonical machine checks decide VERIFIED. An HTTP 200 alone
                    // must never be presented as a verified check.
                    if (result.text.contains("VERIFIED PASS")) {
                        ui.setSystemCheckTaskStatus("COMPLETE  •  VERIFIED")
                    } else {
                        ui.setSystemCheckTaskStatus("COMPLETE  •  PARTIAL / BLOCKED")
                    }
                    ui.addChatMessage("AX", result.text)
                } else if (result.detail.contains("HTTP 404") || result.detail.contains("task not found", ignoreCase = true)) {
                    ui.setSystemCheckTaskStatus("RECOVERING  •  LIVE TASK")
                    brain.findLatestSystemCheck { recovered ->
                        runOnUiThread {
                            if (recovered.state != BrainAdapter.State.CONNECTED) {
                                ui.setSystemCheckTaskStatus("CREATING  •  FRESH TASK")
                                ui.addChatMessage("AX", "The old System Check is gone. Creating a fresh live task and retrying…")
                                brain.createTask(
                                    "System Check",
                                    "Verify Habitat backend connectivity and execute a real QA worker check. Do not claim Android device access unless confirmed."
                                ) { created ->
                                    runOnUiThread {
                                        if (created.state != BrainAdapter.State.CONNECTED) {
                                            ui.setSystemCheckTaskStatus("FAILED  •  TASK CREATE")
                                            ui.addChatMessage("AX", "Fresh System Check task creation failed: " + created.detail)
                                            return@runOnUiThread
                                        }
                                        try {
                                            val task = JSONObject(created.text)
                                            val freshId = task.optString("id", "")
                                            if (freshId.isBlank()) throw IllegalStateException("fresh task has no ID")
                                            lastTaskId = freshId
                                            taskPrefs.edit().putString("live_system_check_task_id", freshId).apply()
                                            runSystemCheck(freshId)
                                        } catch (_: Exception) {
                                            ui.setSystemCheckTaskStatus("FAILED  •  INVALID TASK")
                                            ui.addChatMessage("AX", "Fresh System Check task was created but has no usable ID.")
                                        }
                                    }
                                }
                                return@runOnUiThread
                            }
                            try {
                                val task = JSONObject(recovered.text)
                                val recoveredId = task.optString("id", "")
                                if (recoveredId.isBlank()) throw IllegalStateException("missing task id")
                                lastTaskId = recoveredId
                                taskPrefs.edit().putString("live_system_check_task_id", recoveredId).apply()
                                runSystemCheck(recoveredId)
                            } catch (e: Exception) {
                                ui.setSystemCheckTaskStatus("FAILED  •  INVALID TASK")
                                ui.addChatMessage("AX", "System Check recovery failed: " + (e.message ?: "invalid task"))
                            }
                        }
                    }
                } else {
                    ui.setSystemCheckTaskStatus("FAILED  •  CHECK RESULT")
                    ui.addChatMessage("AX", "System Check failed: " + result.detail)
                }
            }
        }
    }

    private fun ensureSystemCheckTask() {
        val existing = lastTaskId
        if (!existing.isNullOrBlank()) {
            ui.setSystemCheckTaskStatus("VERIFYING  •  TASK")
            brain.findLatestSystemCheck { recovered ->
                runOnUiThread {
                    if (recovered.state == BrainAdapter.State.CONNECTED) {
                        try {
                            val task = JSONObject(recovered.text)
                            val id = task.optString("id", "")
                            if (id.isNotBlank()) {
                                lastTaskId = id
                                taskPrefs.edit().putString("live_system_check_task_id", id).apply()
                                ui.setSystemCheckTaskStatus("LOADED  •  TASK FOUND")
                                return@runOnUiThread
                            }
                        } catch (_: Exception) {}
                    }
                    lastTaskId = null
                    taskPrefs.edit().remove("live_system_check_task_id").apply()
                    ui.setSystemCheckTaskStatus("CREATING…")
                    createFreshSystemCheck()
                }
            }
            return
        }
        ui.setSystemCheckTaskStatus("RECOVERING…")
        brain.findLatestSystemCheck { recovered ->
            runOnUiThread {
                if (recovered.state == BrainAdapter.State.CONNECTED) {
                    try {
                        val task = JSONObject(recovered.text)
                        val id = task.optString("id", "")
                        if (id.isNotBlank()) {
                            lastTaskId = id
                            taskPrefs.edit().putString("live_system_check_task_id", id).apply()
                            ui.setSystemCheckTaskStatus("LOADED  •  TASK FOUND")
                            return@runOnUiThread
                        }
                    } catch (_: Exception) {}
                }
                ui.setSystemCheckTaskStatus("CREATING…")
                brain.createTask(
                    "System Check",
                    "Verify Habitat backend connectivity and execute a real QA worker check. Do not claim Android device access unless confirmed."
                ) { created ->
                    runOnUiThread {
                        if (created.state == BrainAdapter.State.CONNECTED) {
                            try {
                                val task = JSONObject(created.text)
                                val id = task.optString("id", "")
                                if (id.isNotBlank()) {
                                    lastTaskId = id
                                    taskPrefs.edit().putString("live_system_check_task_id", id).apply()
                                    ui.setSystemCheckTaskStatus("LOADED  •  TASK FOUND")
                                } else {
                                    ui.setSystemCheckTaskStatus("ERROR  •  NO ID")
                                }
                            } catch (_: Exception) {
                                ui.setSystemCheckTaskStatus("ERROR  •  INVALID TASK")
                            }
                        } else {
                            ui.setSystemCheckTaskStatus("OFFLINE  •  RETRY")
                        }
                    }
                }
            }
        }
    }

    private fun createFreshSystemCheck() {
        brain.createTask(
            "System Check",
            "Verify Habitat backend connectivity and execute a real QA worker check. Do not claim Android device access unless confirmed."
        ) { created ->
            runOnUiThread {
                if (created.state == BrainAdapter.State.CONNECTED) {
                    try {
                        val task = JSONObject(created.text)
                        val id = task.optString("id", "")
                        if (id.isNotBlank()) {
                            lastTaskId = id
                            taskPrefs.edit().putString("live_system_check_task_id", id).apply()
                            ui.setSystemCheckTaskStatus("LOADED  •  TASK FOUND")
                        } else ui.setSystemCheckTaskStatus("ERROR  •  NO ID")
                    } catch (_: Exception) {
                        ui.setSystemCheckTaskStatus("ERROR  •  INVALID TASK")
                    }
                } else ui.setSystemCheckTaskStatus("OFFLINE  •  RETRY")
            }
        }
    }

    private fun showDeviceBridgeDialog() {
        // Keep pairing inside a stable dialog and never let a network callback
        // touch a dismissed Activity/dialog. Failures stay visible for diagnosis.
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 18, 28, 8)
        }
        val device = TextView(this).apply {
            text = "This phone's device ID:\\n" + deviceBridge.deviceId
            textSize = 14f
            setTextColor(Color.DKGRAY)
        }
        val help = TextView(this).apply {
            text = "Create a one-time pairing code with Ax, then paste it here. The code expires after 10 minutes and can only be used once. Your phone credential is encrypted with Android Keystore."
            textSize = 13f
            setTextColor(Color.DKGRAY)
        }
        val code = EditText(this).apply {
            hint = "One-time AX pairing code"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            textSize = 15f
            setSingleLine(true)
        }
        val status = TextView(this).apply {
            text = "Ready. Waiting for a pairing code."
            textSize = 12f
            setTextColor(Color.DKGRAY)
            setPadding(0, 10, 0, 0)
        }
        val diagnosticsView = TextView(this).apply {
            text = diagnosticsReport()
            textSize = 11f
            setTextColor(Color.rgb(80, 80, 80))
            setPadding(0, 12, 0, 0)
        }
        panel.addView(device)
        panel.addView(help)
        panel.addView(code)
        panel.addView(status)
        panel.addView(diagnosticsView)
        pairingStatusView = status
        pairingDiagnosticsView = diagnosticsView

        val dialog = AlertDialog.Builder(this)
            .setTitle("AX • Secure phone pairing")
            .setView(ScrollView(this).apply { addView(panel) })
            .setNegativeButton("Close", null)
            .setNeutralButton("Disconnect", null)
            .setPositiveButton("Pair phone", null)
            .create()

        pairingDialog = dialog
        dialog.setOnDismissListener {
            pairingDialog = null
            pairingStatusView = null
            pairingButton = null
            pairingDiagnosticsView = null
        }
        dialog.setOnShowListener {
            val pairButton = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            val disconnectButton = dialog.getButton(AlertDialog.BUTTON_NEUTRAL)
            pairingButton = pairButton

            pairButton.setOnClickListener {
                val value = code.text?.toString()?.trim().orEmpty()
                if (value.length !in 20..128) {
                    code.error = "Pairing code must be 20–128 characters"
                    return@setOnClickListener
                }
                pairButton.isEnabled = false
                pairButton.text = "Connecting…"
                status.text = "Contacting Habitat securely. Keep this screen open…"
                code.error = null

                try {
                    deviceBridge.pair(value) { success, reason ->
                        runOnUiThread {
                            // Activity can be recreated while the request is in flight.
                            if (isFinishing || isDestroyed || !dialog.isShowing) return@runOnUiThread
                            try {
                                if (success) {
                                    // The credential is stored, but Ax has not authenticated this
                                    // phone yet. Keep the dialog open and wait for the first
                                    // authenticated poll instead of claiming success here.
                                    deviceBridge.start()
                                    DeviceBridgeScheduler.schedule(this)
                                    status.text = reason
                                    pairButton.text = "Verifying…"
                                    updateBridgeButton()
                                } else {
                                    pairButton.isEnabled = true
                                    pairButton.text = "Pair phone"
                                    status.text = "Pairing did not complete. The screen is still open."
                                    code.error = reason.take(180)
                                    updateBridgeButton()
                                }
                                diagnosticsView.text = diagnosticsReport()
                            } catch (uiError: Throwable) {
                                pairButton.isEnabled = true
                                pairButton.text = "Pair phone"
                                status.text = "Pairing UI error: " + (uiError.message ?: uiError.javaClass.simpleName).take(140)
                            }
                        }
                    }
                } catch (error: Throwable) {
                    pairButton.isEnabled = true
                    pairButton.text = "Pair phone"
                    status.text = "Could not start pairing: " + (error.message ?: error.javaClass.simpleName).take(140)
                }
            }

            disconnectButton.setOnClickListener {
                try {
                    deviceBridge.clearCredentials()
                    DeviceBridgeScheduler.cancel(this)
                    updateBridgeButton()
                    Toast.makeText(this, "AX phone link disconnected.", Toast.LENGTH_SHORT).show()
                } catch (error: Throwable) {
                    Toast.makeText(this, "Disconnect error: " + (error.message ?: "unknown"), Toast.LENGTH_LONG).show()
                }
                dialog.dismiss()
            }
        }
        dialog.show()
    }

    private fun showTikTokPublisherDialog() {
        val panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 24, 32, 8) }
        val account = TextView(this).apply { text = "Loading TikTok creator…"; textSize = 17f; setTextColor(Color.DKGRAY) }
        val job = EditText(this).apply { hint = "Ready-to-publish job ID"; textSize = 16f }
        val title = EditText(this).apply { hint = "Caption / title"; textSize = 16f }
        val privacy = Spinner(this)
        val comment = CheckBox(this).apply { text = "Allow Comment" }
        val duet = CheckBox(this).apply { text = "Allow Duet" }
        val stitch = CheckBox(this).apply { text = "Allow Stitch" }
        val consent = CheckBox(this).apply { text = "I explicitly consent to sending this video to TikTok." }
        panel.addView(account); panel.addView(job); panel.addView(title); panel.addView(privacy)
        panel.addView(comment); panel.addView(duet); panel.addView(stitch); panel.addView(consent)
        val dialog = AlertDialog.Builder(this).setTitle("TikTok • Ax Publish Gate").setView(panel).setNegativeButton("Cancel", null).setPositiveButton("Publish", null).create()
        brain.tiktokCreatorInfo { result ->
            runOnUiThread {
                if (result.state != BrainAdapter.State.CONNECTED) { account.text = "TikTok unavailable: " + result.detail; dialog.show(); return@runOnUiThread }
                try {
                    val j = JSONObject(result.text)
                    account.text = "@" + j.optString("username","unknown") + " • " + j.optString("nickname","TikTok creator")
                    val options = j.optJSONArray("privacyLevelOptions") ?: org.json.JSONArray()
                    val labels = mutableListOf<String>()
                    for (i in 0 until options.length()) labels.add(options.optString(i))
                    privacy.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, labels)
                    comment.isEnabled = !j.optBoolean("commentDisabled", false)
                    duet.isEnabled = !j.optBoolean("duetDisabled", false)
                    stitch.isEnabled = !j.optBoolean("stitchDisabled", false)
                    comment.isChecked = false; duet.isChecked = false; stitch.isChecked = false
                    if (!j.optBoolean("canPost", true)) account.append("\nPosting currently unavailable.")
                    dialog.show()
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                        val selected = privacy.selectedItem?.toString().orEmpty()
                        val jobId = job.text.toString().trim()
                        if (jobId.isBlank() || selected.isBlank() || !consent.isChecked) {
                            Toast.makeText(this, "Job ID, privacy selection, and explicit consent are required.", Toast.LENGTH_LONG).show(); return@setOnClickListener
                        }
                        dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
                        brain.tiktokApproveAndPublish(jobId, title.text.toString().trim(), selected, comment.isChecked, duet.isChecked, stitch.isChecked, true) { out ->
                            runOnUiThread {
                                dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true
                                Toast.makeText(this, if (out.state == BrainAdapter.State.CONNECTED) "TikTok handoff accepted: " + out.text else out.detail, Toast.LENGTH_LONG).show()
                            }
                        }
                    }
                } catch (e: Exception) { account.text = "Invalid creator response: " + e.message; dialog.show() }
            }
        }
    }
    private fun startVoice() {
        if (android.os.Build.VERSION.SDK_INT >= 23 &&
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 701)
            return
        }
        try {
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
            intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "Talk to Ax")
            startActivityForResult(intent, voiceCode)
        } catch (_: Exception) {
            Toast.makeText(this, "Voice input isn't available on this device.", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onResume() {
        super.onResume()
        if (::deviceBridge.isInitialized && deviceBridge.isConfigured()) {
            deviceBridge.start()
            DeviceBridgeScheduler.schedule(this)
        }
    }

    override fun onPause() {
        if (::deviceBridge.isInitialized) {
            // Recorded because the reported pairing failure looked like the app being sent to the
            // home screen; this distinguishes a pause from a crash on the real device.
            if (pairingDialog?.isShowing == true) {
                deviceBridge.recordLifecycle("MainActivity paused while the pairing dialog was open")
            }
            deviceBridge.stop()
        }
        super.onPause()
    }

    override fun onDestroy() {
        if (::deviceBridge.isInitialized) deviceBridge.stop()
        brain.shutdown()
        super.onDestroy()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == voiceCode && resultCode == RESULT_OK) {
            val text = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
            if (!text.isNullOrBlank()) {
                input.setText(text)
                input.setSelection(input.length())
            }
        }
    }
}
