package com.habitat.launcher.ui.pages

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.habitat.launcher.data.LauncherModel
import com.habitat.launcher.ui.components.GlassCard
import com.habitat.launcher.ui.components.SectionHeader
import com.habitat.launcher.ui.components.openSystemSetting
import com.habitat.launcher.ui.theme.Cyan
import com.habitat.launcher.ui.theme.Ice
import com.habitat.launcher.ui.theme.Muted
import kotlinx.coroutines.launch

@Composable
fun DevicePage(model: LauncherModel, onNavigate: (String) -> Unit, onToast: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val device = model.device

    LazyColumn(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 30.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Device", style = MaterialTheme.typography.displaySmall, color = Ice)
                    Text(
                        device?.model ?: "Reading device state…",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Muted
                    )
                }
                IconButton(onClick = {
                    model.refreshDevice()
                    onToast("Device status refreshed.")
                }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh device", tint = Cyan) }
            }
        }
        item {
            GlassCard(modifier = Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Battery", style = MaterialTheme.typography.titleMedium, color = Ice)
                        Text(
                            "${device?.batteryPercent ?: -1}% · " + if (device?.charging == true) "charging" else "on battery",
                            style = MaterialTheme.typography.bodyMedium,
                            color = Muted
                        )
                    }
                    Text(
                        device?.androidVersion ?: "",
                        style = MaterialTheme.typography.labelSmall,
                        color = Muted
                    )
                }
            }
        }
        item {
            GlassCard(modifier = Modifier.fillMaxWidth()) {
                Text("Storage", style = MaterialTheme.typography.titleMedium, color = Ice)
                val total = device?.storageTotalGb ?: 0.0
                val free = device?.storageFreeGb ?: 0.0
                val used = (total - free).coerceAtLeast(0.0)
                Text(
                    String.format(java.util.Locale.US, "%.1f GB free of %.1f GB", free, total),
                    style = MaterialTheme.typography.bodyMedium,
                    color = Muted
                )
                Spacer(Modifier.height(8.dp))
                LinearProgressIndicator(
                    progress = { if (total > 0) (used / total).toFloat() else 0f },
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "Memory: ${device?.ramFreeMb ?: 0} MB available",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Muted
                )
            }
        }
        item {
            GlassCard(modifier = Modifier.fillMaxWidth()) {
                Text("Connectivity", style = MaterialTheme.typography.titleMedium, color = Ice)
                Text(
                    if (device?.online == true) "Network available" else "No network reported",
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (device?.online == true) Cyan else MaterialTheme.colorScheme.error
                )
                Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    TextButton(onClick = { openSystemSetting(context, Settings.ACTION_WIFI_SETTINGS) }) { Text("Wi-Fi", color = Cyan) }
                    TextButton(onClick = { openSystemSetting(context, Settings.ACTION_BLUETOOTH_SETTINGS) }) { Text("Bluetooth", color = Cyan) }
                    TextButton(onClick = { openSystemSetting(context, Settings.ACTION_DATA_USAGE_SETTINGS) }) { Text("Data", color = Cyan) }
                }
            }
        }
        item { SectionHeader("Shortcuts") }
        item { SettingRow("Battery saver") { openSystemSetting(context, Settings.ACTION_BATTERY_SAVER_SETTINGS) } }
        item { SettingRow("Display and refresh rate") { openSystemSetting(context, Settings.ACTION_DISPLAY_SETTINGS) } }
        item { SettingRow("Application permissions") { openSystemSetting(context, Settings.ACTION_APPLICATION_SETTINGS) } }
        item { SettingRow("Home app") { openSystemSetting(context, Settings.ACTION_HOME_SETTINGS) } }
        item { SectionHeader("Authorized device automation") }
        item {
            GlassCard(modifier = Modifier.fillMaxWidth()) {
                Text(
                    "Habitat owns device automation. The launcher never taps, swipes or types on your behalf, and it holds no Ax token. Owner approval and revocation stay in the Habitat console.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Muted
                )
                Spacer(Modifier.height(8.dp))
                TextButton(onClick = { onNavigate("habitat") }) { Text("Open Habitat status", color = Cyan) }
            }
        }
        item {
            TextButton(onClick = { scope.launch { model.refreshHabitat() } }) {
                Text("Refresh Habitat connection", color = Muted)
            }
        }
    }
}

@Composable
private fun SettingRow(title: String, onClick: () -> Unit) {
    GlassCard(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = Ice)
    }
}
