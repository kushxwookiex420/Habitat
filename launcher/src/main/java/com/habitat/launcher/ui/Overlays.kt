package com.habitat.launcher.ui

import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.habitat.launcher.data.LauncherModel
import com.habitat.launcher.logic.LauncherPages
import com.habitat.launcher.ui.components.AppIcon
import com.habitat.launcher.ui.components.GlassCard
import com.habitat.launcher.ui.components.SectionHeader
import com.habitat.launcher.ui.theme.Cyan
import com.habitat.launcher.ui.theme.DeepNavy
import com.habitat.launcher.ui.theme.Ice
import com.habitat.launcher.ui.theme.Muted
import com.habitat.launcher.ui.theme.Void

@Composable
fun SearchOverlay(
    model: LauncherModel,
    onDismiss: () -> Unit,
    onNavigate: (String) -> Unit,
    onOpenApp: (String) -> Unit
) {
    var query by remember { mutableStateOf("") }
    val appHits = remember(query, model.apps) {
        if (query.isBlank()) emptyList()
        else model.apps.filter {
            it.label.contains(query, true) || it.packageName.contains(query, true)
        }.take(12)
    }
    val pageHits = remember(query) {
        if (query.isBlank()) emptyList()
        else LauncherPages.all.filter { it.title.contains(query, true) || it.id.contains(query, true) }
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = Void.copy(alpha = 0.98f)) {
            Column(Modifier.statusBarsPadding().navigationBarsPadding().padding(20.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        modifier = Modifier.weight(1f),
                        singleLine = true,
                        placeholder = { Text("Search apps, pages, commands", color = Muted) },
                        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null, tint = Cyan) },
                        shape = RoundedCornerShape(18.dp),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search, keyboardType = KeyboardType.Text)
                    )
                    TextButton(onClick = onDismiss) { Text("Close", color = Muted) }
                }
                LazyColumn(Modifier.padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (pageHits.isNotEmpty()) {
                        item { SectionHeader("Pages") }
                        items(pageHits.size) { index ->
                            val page = pageHits[index]
                            SearchRow(title = page.title, subtitle = page.kicker) { onNavigate(page.id) }
                        }
                    }
                    if (appHits.isNotEmpty()) {
                        item { SectionHeader("Applications") }
                        items(appHits.size) { index ->
                            val app = appHits[index]
                            Row(
                                Modifier.fillMaxWidth().clickable { onOpenApp(app.packageName) }
                                    .padding(vertical = 9.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                AppIcon(app, size = 34)
                                Spacer(Modifier.width(12.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(app.label, style = MaterialTheme.typography.titleMedium, color = Ice)
                                    Text(app.packageName, style = MaterialTheme.typography.bodyMedium, color = Muted)
                                }
                                Icon(Icons.Filled.KeyboardArrowRight, contentDescription = null, tint = Muted)
                            }
                        }
                    }
                    if (query.isBlank()) {
                        item {
                            Text(
                                "Try \"habitat\", \"settings\", a contact-free app name, or open AX Home and say \"help\".",
                                style = MaterialTheme.typography.bodyMedium,
                                color = Muted
                            )
                        }
                    } else if (pageHits.isEmpty() && appHits.isEmpty()) {
                        item {
                            Text(
                                "Nothing matched \"$query\".",
                                style = MaterialTheme.typography.bodyMedium,
                                color = Muted
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SearchRow(title: String, subtitle: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = Ice)
            Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = Muted)
        }
        Icon(Icons.Filled.KeyboardArrowRight, contentDescription = null, tint = Muted)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsSheet(model: LauncherModel, onDismiss: () -> Unit, onToast: (String) -> Unit) {
    val context = LocalContext.current
    var url by remember { mutableStateOf(model.baseUrl) }
    val roleLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {}

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = DeepNavy) {
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(horizontal = 22.dp, vertical = 6.dp)
        ) {
            Text("Launcher settings", style = MaterialTheme.typography.headlineMedium, color = Ice)
            Text(
                "Habitat AX is an independent HOME app. One UI remains available as a fallback at any time.",
                style = MaterialTheme.typography.bodyMedium,
                color = Muted,
                modifier = Modifier.padding(top = 4.dp, bottom = 12.dp)
            )
            Button(
                onClick = {
                    val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        val manager = context.getSystemService(android.app.role.RoleManager::class.java)
                        if (manager != null && manager.isRoleAvailable(android.app.role.RoleManager.ROLE_HOME)) {
                            manager.createRequestRoleIntent(android.app.role.RoleManager.ROLE_HOME)
                        } else {
                            Intent(Settings.ACTION_HOME_SETTINGS)
                        }
                    } else {
                        Intent(Settings.ACTION_HOME_SETTINGS)
                    }
                    runCatching { roleLauncher.launch(intent) }
                        .onFailure { onToast("This device has no home-app settings screen.") }
                },
                shape = RoundedCornerShape(16.dp)
            ) { Text("Use Habitat AX as default home") }

            SectionHeader("Page order", "Move pages with the arrows. Swipe horizontally on the home screen.")
            for (index in model.pageOrder.indices) {
                val id = model.pageOrder[index]
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        LauncherPages.byId(id).title,
                        style = MaterialTheme.typography.titleMedium,
                        color = Ice,
                        modifier = Modifier.weight(1f)
                    )
                    IconButton(onClick = { model.movePage(id, -1) }, enabled = index > 0) {
                        Icon(Icons.Filled.ArrowUpward, contentDescription = "Move up", tint = if (index > 0) Cyan else Muted)
                    }
                    IconButton(onClick = { model.movePage(id, 1) }, enabled = index < model.pageOrder.lastIndex) {
                        Icon(
                            Icons.Filled.ArrowDownward,
                            contentDescription = "Move down",
                            tint = if (index < model.pageOrder.lastIndex) Cyan else Muted
                        )
                    }
                }
            }
            TextButton(onClick = { model.resetPageOrder(); onToast("Page order reset.") }) {
                Text("Reset order", color = Cyan)
            }

            SectionHeader("Layout and gestures")
            ToggleRow("Bottom app dock", model.taskbar) { model.updateTaskbar(it) }
            ToggleRow("Swipe up for search", model.swipeUpSearch) { model.updateSwipeUpSearch(it) }

            SectionHeader("Habitat endpoint", "Read-only status. No credential is stored in the launcher.")
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                shape = RoundedCornerShape(14.dp),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri)
            )
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = {
                        model.saveBaseUrl(url)
                        url = model.baseUrl
                        onToast("Endpoint saved. Refresh Habitat to load it.")
                    },
                    shape = RoundedCornerShape(14.dp)
                ) { Text("Save") }
                TextButton(onClick = { url = com.habitat.launcher.data.LauncherPrefs.DEFAULT_BASE_URL }) {
                    Text("Reset to default", color = Muted)
                }
            }

            GlassCard(modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp)) {
                Text("Authorization boundary", style = MaterialTheme.typography.titleMedium, color = Ice)
                Spacer(Modifier.height(4.dp))
                Text(
                    "This launcher reads public Habitat status and opens local apps. It does not hold an Ax token and cannot run owner-approved device actions.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Muted
                )
            }
            Text("Habitat AX launcher 1.0.0", style = MaterialTheme.typography.labelSmall, color = Muted)
        }
    }
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyLarge, color = Ice, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}
