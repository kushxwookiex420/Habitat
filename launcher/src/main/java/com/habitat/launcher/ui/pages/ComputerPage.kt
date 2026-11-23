package com.habitat.launcher.ui.pages

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.habitat.launcher.data.LauncherModel
import com.habitat.launcher.ui.components.GlassCard
import com.habitat.launcher.ui.components.SectionHeader
import com.habitat.launcher.ui.components.openUrl
import com.habitat.launcher.ui.theme.Cyan
import com.habitat.launcher.ui.theme.Ice
import com.habitat.launcher.ui.theme.Muted
import com.habitat.launcher.ui.theme.Turquoise

@Composable
fun ComputerPage(model: LauncherModel, onToast: (String) -> Unit) {
    val context = LocalContext.current

    fun openOrExplain(packageName: String, label: String, fallbackUrl: String? = null) {
        if (model.isInstalled(packageName) && model.openApp(packageName)) {
            onToast("Opening $label")
            return
        }
        if (fallbackUrl != null && openUrl(context, fallbackUrl)) {
            onToast("$label is not installed — opened the web version.")
            return
        }
        onToast("$label is not installed on this phone.")
    }

    LazyColumn(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 30.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Text("Computer", style = MaterialTheme.typography.displaySmall, color = Ice)
            Text(
                "Local Linux, remote desktops and a development workspace.",
                style = MaterialTheme.typography.bodyMedium,
                color = Muted
            )
        }
        item { SectionHeader("Linux environment") }
        item {
            ComputerLink(
                title = "Termux",
                subtitle = if (model.isInstalled("com.termux")) "Linux shell installed" else "Install Termux to run a local Linux shell",
                status = if (model.isInstalled("com.termux")) "READY" else "NOT INSTALLED"
            ) { openOrExplain("com.termux", "Termux", "https://f-droid.org/packages/com.termux/") }
        }
        item {
            ComputerLink(
                title = "File manager",
                subtitle = if (model.isInstalled("com.google.android.documentsui")) "Files installed" else "Open the system file picker",
                status = if (model.isInstalled("com.google.android.documentsui")) "READY" else "FALLBACK"
            ) { openOrExplain("com.google.android.documentsui", "Files") }
        }
        item { SectionHeader("Remote computers") }
        item {
            ComputerLink(
                title = "Windows desktop",
                subtitle = if (model.isInstalled("com.microsoft.rdc.androidx")) "Remote Desktop installed" else "Remote Desktop is not installed",
                status = if (model.isInstalled("com.microsoft.rdc.androidx")) "READY" else "NOT INSTALLED"
            ) { openOrExplain("com.microsoft.rdc.androidx", "Remote Desktop") }
        }
        item {
            ComputerLink(
                title = "Mac desktop",
                subtitle = "Opens your browser; install a VNC or remote-desktop client for direct access",
                status = "WEB"
            ) { openUrl(context, "https://www.apple.com/remotedesktop/") }
        }
        item { SectionHeader("Workspace") }
        item {
            ComputerLink(
                title = "Browser",
                subtitle = "Open the web with the default browser",
                status = "WEB"
            ) { if (!openUrl(context, "https://github.com")) onToast("No browser is available.") }
        }
        item {
            ComputerLink(
                title = "GitHub Codespaces",
                subtitle = "A cloud development workspace in the browser",
                status = "WEB"
            ) { if (!openUrl(context, "https://github.com/codespaces")) onToast("No browser is available.") }
        }
        item {
            GlassCard(modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
                Text("No hidden execution", style = MaterialTheme.typography.titleMedium, color = Ice)
                Spacer(Modifier.height(4.dp))
                Text(
                    "This page only launches apps and URLs you choose. It does not run shell commands, start remote sessions, or claim a connection succeeded.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Muted
                )
            }
        }
    }
}

@Composable
private fun ComputerLink(title: String, subtitle: String, status: String, onClick: () -> Unit) {
    GlassCard(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = Ice)
                Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = Muted)
            }
            Text(
                status,
                style = MaterialTheme.typography.labelSmall,
                color = if (status == "READY") Turquoise else Cyan
            )
        }
    }
}
