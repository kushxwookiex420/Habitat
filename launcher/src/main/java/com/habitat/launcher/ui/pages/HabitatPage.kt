package com.habitat.launcher.ui.pages

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.habitat.launcher.data.LauncherModel
import com.habitat.launcher.ui.components.EmptyState
import com.habitat.launcher.ui.components.GlassCard
import com.habitat.launcher.ui.components.SectionHeader
import com.habitat.launcher.ui.components.StatusPill
import com.habitat.launcher.ui.components.openUrl
import com.habitat.launcher.ui.components.toneFor
import com.habitat.launcher.ui.TaskDetailSheet
import com.habitat.launcher.ui.theme.Cyan
import com.habitat.launcher.ui.theme.Ice
import com.habitat.launcher.ui.theme.Muted
import com.habitat.launcher.ui.theme.Warning
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun HabitatPage(model: LauncherModel, onNavigate: (String) -> Unit, onToast: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var detailTaskId by remember { mutableStateOf<String?>(null) }

    LazyColumn(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 30.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Habitat", style = MaterialTheme.typography.displaySmall, color = Ice)
                    Text(
                        "Read-only live state from the Habitat service.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Muted
                    )
                }
                IconButton(onClick = {
                    onToast("Refreshing Habitat…")
                    scope.launch { model.refreshHabitat() }
                }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh Habitat", tint = Cyan) }
                IconButton(onClick = {
                    if (!openUrl(context, model.baseUrl.trimEnd('/') + "/health")) {
                        onToast("No browser is available.")
                    }
                }) { Icon(Icons.Filled.OpenInNew, contentDescription = "Open diagnostics", tint = Muted) }
            }
        }
        item {
            GlassCard(modifier = Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Device presence", style = MaterialTheme.typography.titleMedium, color = Ice)
                        Text(
                            model.habitatStatus?.detail?.ifBlank { "No detail reported." } ?: "Waiting for a response.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = Muted
                        )
                    }
                    StatusPill(model.habitatStatus?.access ?: if (model.habitatLoading) "loading" else "UNKNOWN", toneFor(model.habitatStatus?.access ?: "unknown"))
                }
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val live = model.habitatStatus?.liveCount
                    StatusPill(
                        if (live != null) "$live live" else "${model.habitatStatus?.deviceCount ?: 0} devices",
                        Cyan
                    )
                    StatusPill(
                        "${model.habitatStatus?.registeredCount ?: model.habitatStatus?.deviceCount ?: 0} registered",
                        Muted
                    )
                    StatusPill(
                        model.lastSyncAt?.let { "synced " + SimpleDateFormat("HH:mm", Locale.US).format(Date(it)) } ?: "not synced",
                        if (model.habitatError == null) Cyan else Warning
                    )
                }
                model.habitatError?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, style = MaterialTheme.typography.bodyMedium, color = Color(0xFFFFB4B4))
                }
            }
        }
        item { SectionHeader("Automation controls", "Owner approval is enforced by Habitat, not by the launcher.") }
        item {
            GlassCard(modifier = Modifier.fillMaxWidth()) {
                Text(
                    "The launcher can read status, but it does not hold an Ax token and cannot approve or run device actions. Use the Habitat console on the backend for owner-approved work.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Muted
                )
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { onNavigate("device") }) { Text("Device status", color = Cyan) }
                    TextButton(onClick = {
                        if (!openUrl(context, model.baseUrl.trimEnd('/'))) onToast("No browser is available.")
                    }) { Text("Open console", color = Cyan) }
                }
            }
        }
        item { SectionHeader("Worker network", "${model.workers.count { it.status == "available" }} available of ${model.workers.size}") }
        if (model.workers.isEmpty()) {
            item {
                EmptyState(
                    "No workers reported",
                    "Refresh while Habitat is reachable. Workers appear only when the server returns its registry."
                )
            }
        } else {
            items(model.workers.size) { index ->
                val worker = model.workers[index]
                GlassCard(modifier = Modifier.fillMaxWidth()) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(worker.name.ifBlank { worker.id }, style = MaterialTheme.typography.titleMedium, color = Ice)
                            Text(
                                worker.id + " · " + worker.jobCount + " jobs",
                                style = MaterialTheme.typography.bodyMedium,
                                color = Muted
                            )
                        }
                        StatusPill(worker.status, toneFor(worker.status))
                    }
                    worker.blockedReason?.let {
                        Spacer(Modifier.height(8.dp))
                        Text("Blocked because: $it", style = MaterialTheme.typography.bodyMedium, color = Color(0xFFFFB4B4))
                    }
                    if (worker.capabilities.isNotEmpty()) {
                        Spacer(Modifier.height(6.dp))
                        Text(
                            worker.capabilities.take(4).joinToString(" · "),
                            style = MaterialTheme.typography.labelSmall,
                            color = Muted
                        )
                    }
                }
            }
        }
        item { SectionHeader("Task queue and receipts", "Newest first, exactly as stored.") }
        if (model.tasks.isEmpty()) {
            item { EmptyState("No task receipts", "Habitat has not returned a stored task.") }
        } else {
            items(model.tasks.size) { index ->
                val task = model.tasks[index]
                GlassCard(modifier = Modifier.fillMaxWidth().clickable { detailTaskId = task.id }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(task.title.ifBlank { task.id }, style = MaterialTheme.typography.titleMedium, color = Ice)
                            Text(
                                task.id.take(12) + " · " + task.worker.ifBlank { "unassigned" },
                                style = MaterialTheme.typography.labelSmall,
                                color = Muted
                            )
                            Text(
                                task.createdAt ?: "time unknown",
                                style = MaterialTheme.typography.labelSmall,
                                color = Muted
                            )
                        }
                        StatusPill(task.status, toneFor(task.status))
                    }
                    task.error?.let {
                        Spacer(Modifier.height(6.dp))
                        Text(it, style = MaterialTheme.typography.bodyMedium, color = Color(0xFFFFB4B4))
                    }
                }
            }
        }
    }

    detailTaskId?.let { taskId ->
        TaskDetailSheet(taskId = taskId, model = model, onDismiss = { detailTaskId = null }, onToast = onToast)
    }
}
