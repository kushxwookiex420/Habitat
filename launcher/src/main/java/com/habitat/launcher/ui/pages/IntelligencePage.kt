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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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

@Composable
fun IntelligencePage(
    model: LauncherModel,
    onSearch: () -> Unit,
    onCommand: (String) -> Unit,
    onToast: (String) -> Unit
) {
    val context = LocalContext.current
    var prompt by remember { mutableStateOf("") }

    LazyColumn(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 30.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Text("Intelligence", style = MaterialTheme.typography.displaySmall, color = Ice)
            Text(
                "Research, opportunities and the tools around AX.",
                style = MaterialTheme.typography.bodyMedium,
                color = Muted
            )
        }
        item {
            GlassCard(modifier = Modifier.fillMaxWidth()) {
                Text("AX assistant", style = MaterialTheme.typography.titleMedium, color = Ice)
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = prompt,
                        onValueChange = { prompt = it },
                        modifier = Modifier.weight(1f),
                        singleLine = true,
                        placeholder = { Text("Ask AX to open a page or app", color = Muted) },
                        shape = RoundedCornerShape(16.dp)
                    )
                    IconButton(onClick = {
                        if (prompt.isNotBlank()) {
                            onCommand(prompt)
                            prompt = ""
                        }
                    }) { Icon(Icons.Filled.Send, contentDescription = "Send", tint = Cyan) }
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    "AX answers locally today: it opens pages and installed apps. It does not invent research results or claim a device action.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Muted
                )
            }
        }
        item { SectionHeader("Research workspace") }
        item {
            GlassCard(modifier = Modifier.fillMaxWidth().clickable { onSearch() }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Search, contentDescription = null, tint = Cyan)
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Launcher search", style = MaterialTheme.typography.titleMedium, color = Ice)
                        Text("Pages and installed applications", style = MaterialTheme.typography.bodyMedium, color = Muted)
                    }
                }
            }
        }
        item { ResearchLink("Web research", "Open a browser search", "https://www.google.com") }
        item { ResearchLink("Opportunity discovery", "Open Habitat tasks and worker receipts", null) { onCommand("go to habitat") } }
        item { ResearchLink("Connected services", "Open the Habitat health endpoint", model.baseUrl.trimEnd('/') + "/health") }
        item { SectionHeader("AI tools") }
        item { ResearchLink("ChatGPT", "Open in the browser", "https://chatgpt.com") }
        item { ResearchLink("Claude", "Open in the browser", "https://claude.ai") }
        item { ResearchLink("Gemini", "Open in the browser", "https://gemini.google.com") }
        item { ResearchLink("Perplexity", "Open in the browser", "https://www.perplexity.ai") }
        item { SectionHeader("Knowledge and projects") }
        item {
            GlassCard(modifier = Modifier.fillMaxWidth()) {
                Text("Project workspace", style = MaterialTheme.typography.titleMedium, color = Ice)
                Spacer(Modifier.height(4.dp))
                Text(
                    "App folders act as local project collections. Create one from Applications, then group the tools for a project.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Muted
                )
                Spacer(Modifier.height(6.dp))
                Text("Open Applications →", style = MaterialTheme.typography.labelLarge, color = Cyan,
                    modifier = Modifier.clickable { onCommand("go to apps") })
            }
        }
    }
}

@Composable
private fun ResearchLink(title: String, subtitle: String, url: String?, onClick: (() -> Unit)? = null) {
    val context = LocalContext.current
    GlassCard(
        modifier = Modifier.fillMaxWidth().clickable {
            if (onClick != null) onClick()
            else if (url != null) runCatching { openUrl(context, url) }
        }
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = Ice)
        Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = Muted)
    }
}
