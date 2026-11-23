package com.habitat.launcher.ui.pages

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.habitat.launcher.data.LauncherModel
import com.habitat.launcher.ui.components.EmptyState
import com.habitat.launcher.ui.components.GlassCard
import com.habitat.launcher.ui.components.NeuralBrain
import com.habitat.launcher.ui.components.SectionHeader
import com.habitat.launcher.ui.components.StatusPill
import com.habitat.launcher.ui.components.toneFor
import com.habitat.launcher.ui.theme.Cyan
import com.habitat.launcher.ui.theme.Ice
import com.habitat.launcher.ui.theme.Muted
import com.habitat.launcher.ui.theme.Turquoise
import kotlinx.coroutines.launch
import java.time.LocalTime

@Composable
fun AxHomePage(
    model: LauncherModel,
    onNavigate: (String) -> Unit,
    onSearch: () -> Unit,
    onCommand: (String) -> Unit,
    onToast: (String) -> Unit
) {
    var command by remember { mutableStateOf("") }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val voice = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val spoken = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
            if (!spoken.isNullOrBlank()) {
                command = spoken
                onCommand(spoken)
            }
        }
    }

    LazyColumn(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 28.dp)
    ) {
        item {
            Text(
                greeting(),
                style = MaterialTheme.typography.displaySmall,
                color = Ice
            )
            Text(
                "Your command layer is ready.",
                style = MaterialTheme.typography.bodyMedium,
                color = Muted
            )
        }
        item {
            Box(Modifier.fillMaxWidth().padding(vertical = 6.dp), contentAlignment = Alignment.Center) {
                NeuralBrain(size = 248)
            }
        }
        item {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                val habitatTone = when {
                    model.habitatError != null -> Color(0xFFFF7A7A)
                    model.habitatStatus?.ok == true -> toneFor("online")
                    else -> toneFor("unknown")
                }
                StatusPill(
                    text = if (model.habitatError != null) "Habitat offline" else "Habitat ${model.habitatStatus?.access ?: "checking"}",
                    tone = habitatTone
                )
                model.device?.let { StatusPill("${it.batteryPercent}%", if (it.batteryPercent in 0..20) Color(0xFFF5C56B) else Cyan) }
                StatusPill("${model.workers.count { it.status == "available" }}/${model.workers.size} workers", Turquoise)
            }
        }
        item {
            Row(
                Modifier.fillMaxWidth().padding(top = 14.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedTextField(
                    value = command,
                    onValueChange = { command = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Ask AX or say \"open camera\"", color = Muted) },
                    singleLine = true,
                    shape = RoundedCornerShape(18.dp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = Cyan.copy(alpha = 0.7f),
                        unfocusedBorderColor = Cyan.copy(alpha = 0.22f),
                        focusedContainerColor = Color(0x660A1322),
                        unfocusedContainerColor = Color(0x660A1322),
                        cursorColor = Cyan
                    )
                )
                IconButton(
                    onClick = {
                        try {
                            voice.launch(
                                Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                                    putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak to AX")
                                }
                            )
                        } catch (_: ActivityNotFoundException) {
                            onToast("No speech recognizer is installed.")
                        }
                    }
                ) { Icon(Icons.Filled.Mic, contentDescription = "Voice command", tint = Turquoise) }
                IconButton(
                    onClick = {
                        if (command.isNotBlank()) {
                            onCommand(command)
                            command = ""
                        }
                    }
                ) { Icon(Icons.Filled.Send, contentDescription = "Send command", tint = Cyan) }
            }
        }
        item {
            LazyRow(
                Modifier.fillMaxWidth().padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                item { QuickChip("Applications") { onNavigate("apps") } }
                item { QuickChip("Habitat") { onNavigate("habitat") } }
                item { QuickChip("Computer") { onNavigate("computer") } }
                item { QuickChip("Device") { onNavigate("device") } }
                item { QuickChip("Search") { onSearch() } }
            }
        }
        item {
            SectionHeader(
                title = "Active tasks",
                subtitle = if (model.lastSyncAt != null) "Live from Habitat" else "Waiting for Habitat",
                trailing = {
                    IconButton(onClick = {
                        onToast("Refreshing Habitat…")
                        model.refreshDevice()
                        scope.launch { model.refreshHabitat() }
                    }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = Muted)
                    }
                }
            )
        }
        if (model.habitatError != null) {
            item {
                GlassCard(accent = Color(0xFFFF7A7A)) {
                    Text("Habitat is unreachable", style = MaterialTheme.typography.titleMedium, color = Ice)
                    Spacer(Modifier.height(4.dp))
                    Text(model.habitatError.orEmpty(), style = MaterialTheme.typography.bodyMedium, color = Muted)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Check the base URL in settings, then refresh from the Habitat page.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Muted
                    )
                }
            }
        } else if (model.tasks.isEmpty()) {
            item {
                EmptyState(
                    "No active tasks",
                    "Habitat has not reported a task yet. Open the Habitat page to read workers, receipts and diagnostics."
                )
            }
        } else {
            items(model.tasks.take(3).size) { index ->
                val task = model.tasks[index]
                GlassCard(modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(task.title.ifBlank { task.id }, style = MaterialTheme.typography.titleMedium, color = Ice)
                            Text(
                                "${task.worker.ifBlank { "worker" }} · ${task.createdAt ?: "time unknown"}",
                                style = MaterialTheme.typography.bodyMedium,
                                color = Muted
                            )
                            task.error?.let {
                                Spacer(Modifier.height(4.dp))
                                Text(it, style = MaterialTheme.typography.bodyMedium, color = Color(0xFFFFB4B4))
                            }
                        }
                        StatusPill(task.status, toneFor(task.status))
                    }
                }
            }
        }
    }
}

@Composable
private fun QuickChip(label: String, onClick: () -> Unit) {
    AssistChip(
        onClick = onClick,
        label = { Text(label, color = Ice, fontWeight = FontWeight.Medium) },
        shape = RoundedCornerShape(14.dp),
        colors = AssistChipDefaults.assistChipColors(containerColor = Color(0x66101C2E)),
        border = androidx.compose.foundation.BorderStroke(1.dp, Cyan.copy(alpha = 0.22f))
    )
}

private fun greeting(): String {
    val hour = LocalTime.now().hour
    return when {
        hour < 5 -> "Working late."
        hour < 12 -> "Good morning."
        hour < 18 -> "Good afternoon."
        else -> "Good evening."
    }
}
