package com.habitat.launcher.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.habitat.launcher.data.LauncherModel
import com.habitat.launcher.data.TaskReceipt
import com.habitat.launcher.ui.components.GlassCard
import com.habitat.launcher.ui.components.StatusPill
import com.habitat.launcher.ui.components.toneFor
import com.habitat.launcher.ui.theme.Cyan
import com.habitat.launcher.ui.theme.DeepNavy
import com.habitat.launcher.ui.theme.Ice
import com.habitat.launcher.ui.theme.Muted
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskDetailSheet(
    taskId: String,
    model: LauncherModel,
    onDismiss: () -> Unit,
    onToast: (String) -> Unit
) {
    val scope = rememberCoroutineScope()
    var receipt by remember { mutableStateOf<TaskReceipt?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }

    suspend fun load() {
        loading = true
        error = null
        val result = model.loadTaskReceipt(taskId)
        result.onSuccess { receipt = it }.onFailure { error = it.message ?: "Task receipt unavailable." }
        loading = false
    }

    LaunchedEffect(taskId) { load() }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = DeepNavy) {
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(horizontal = 22.dp, vertical = 6.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(receipt?.title?.ifBlank { taskId } ?: "Task receipt", style = MaterialTheme.typography.headlineMedium, color = Ice)
                    Text(taskId, style = MaterialTheme.typography.labelSmall, color = Muted)
                }
                IconButton(onClick = { scope.launch { load() } }) {
                    Icon(Icons.Filled.Refresh, contentDescription = "Refresh receipt", tint = Cyan)
                }
            }
            if (receipt != null) {
                val task = receipt!!
                Row(Modifier.padding(top = 6.dp)) {
                    StatusPill(task.status, toneFor(task.status))
                    Spacer(Modifier.padding(horizontal = 4.dp))
                    StatusPill(task.worker.ifBlank { "unassigned" }, Muted)
                }
                if (task.description.isNotBlank()) {
                    Spacer(Modifier.height(10.dp))
                    Text(task.description, style = MaterialTheme.typography.bodyMedium, color = Muted)
                }
                Spacer(Modifier.height(10.dp))
                GlassCard(modifier = Modifier.fillMaxWidth()) {
                    Text("Timeline", style = MaterialTheme.typography.titleMedium, color = Ice)
                    Timeline("Created", task.createdAt)
                    Timeline("Delegated", task.delegatedAt)
                    Timeline("Completed", task.completedAt)
                    Timeline("Verified", task.verifiedAt)
                }
                if (task.error != null) {
                    Spacer(Modifier.height(10.dp))
                    GlassCard(modifier = Modifier.fillMaxWidth(), accent = Color(0xFFFF7A7A)) {
                        Text("Error", style = MaterialTheme.typography.titleMedium, color = Ice)
                        Text(task.error, style = MaterialTheme.typography.bodyMedium, color = Color(0xFFFFB4B4))
                    }
                }
                if (task.blockedReason != null) {
                    Spacer(Modifier.height(10.dp))
                    GlassCard(modifier = Modifier.fillMaxWidth(), accent = Color(0xFFF5C56B)) {
                        Text("Blocked because", style = MaterialTheme.typography.titleMedium, color = Ice)
                        Text(task.blockedReason, style = MaterialTheme.typography.bodyMedium, color = Muted)
                    }
                }
                if (task.checks.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    GlassCard(modifier = Modifier.fillMaxWidth()) {
                        Text("Machine checks", style = MaterialTheme.typography.titleMedium, color = Ice)
                        Spacer(Modifier.height(6.dp))
                        for (check in task.checks) {
                            Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(check.name, style = MaterialTheme.typography.bodyMedium, color = Ice, modifier = Modifier.weight(1f))
                                StatusPill(check.status, toneFor(check.status))
                            }
                            check.detail?.let {
                                Text(it, style = MaterialTheme.typography.bodyMedium, color = Muted)
                            }
                        }
                    }
                }
                if (task.resultSummary != null) {
                    Spacer(Modifier.height(10.dp))
                    GlassCard(modifier = Modifier.fillMaxWidth()) {
                        Text("Receipt payload", style = MaterialTheme.typography.titleMedium, color = Ice)
                        Spacer(Modifier.height(4.dp))
                        Text(task.resultSummary, style = MaterialTheme.typography.bodyMedium, color = Muted)
                    }
                }
                Spacer(Modifier.height(10.dp))
                GlassCard(modifier = Modifier.fillMaxWidth()) {
                    Text("Retry authorization", style = MaterialTheme.typography.titleMedium, color = Ice)
                    Text(
                        "The launcher is read-only. Retry is an owner action and the retry endpoint has no launcher authentication, so no retry button is shown here. Use the Habitat console.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Muted
                    )
                }
            } else if (loading) {
                Text("Loading the task receipt…", style = MaterialTheme.typography.bodyMedium, color = Muted)
            } else {
                GlassCard(modifier = Modifier.fillMaxWidth(), accent = Color(0xFFFF7A7A)) {
                    Text("Receipt unavailable", style = MaterialTheme.typography.titleMedium, color = Ice)
                    Text(error ?: "Habitat did not return this task.", style = MaterialTheme.typography.bodyMedium, color = Muted)
                    TextButton(onClick = { scope.launch { load() } }) { Text("Try again", color = Cyan) }
                }
            }
            TextButton(onClick = onDismiss, modifier = Modifier.padding(vertical = 10.dp)) {
                Text("Close", color = Muted)
            }
        }
    }
}

@Composable
private fun Timeline(label: String, value: String?) {
    Row(Modifier.fillMaxWidth().padding(top = 3.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = Muted, modifier = Modifier.weight(1f))
        Text(value ?: "—", style = MaterialTheme.typography.bodyMedium, color = Ice)
    }
}
