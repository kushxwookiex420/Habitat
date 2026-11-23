package com.habitat.launcher.ui.pages

import android.os.Build
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.habitat.launcher.data.LauncherModel
import com.habitat.launcher.ui.components.AppIcon
import com.habitat.launcher.ui.components.EmptyState
import com.habitat.launcher.ui.components.GlassCard
import com.habitat.launcher.ui.components.SectionHeader
import com.habitat.launcher.ui.components.openUrl
import com.habitat.launcher.ui.theme.Cyan
import com.habitat.launcher.ui.theme.Ice
import com.habitat.launcher.ui.theme.Muted

@Composable
fun GamingPage(model: LauncherModel, onToast: (String) -> Unit) {
    val context = LocalContext.current
    val games = model.apps.filter { it.isGame }
    @Suppress("DEPRECATION")
    val refreshRate = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        context.display?.refreshRate ?: 60f
    } else {
        context.windowManager.defaultDisplay.refreshRate
    }

    LazyColumn(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 30.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Text("Gaming", style = MaterialTheme.typography.displaySmall, color = Ice)
            Text(
                "Native games, Winlator and cloud libraries.",
                style = MaterialTheme.typography.bodyMedium,
                color = Muted
            )
        }
        item { SectionHeader("Installed games", "${games.size} detected") }
        if (games.isEmpty()) {
            item {
                EmptyState(
                    "No games detected",
                    "Android only reports the Game category for some titles. Launch any game from Applications if it is missing here."
                )
            }
        } else {
            items(games.size) { index ->
                val game = games[index]
                Row(
                    Modifier.fillMaxWidth().clickable {
                        if (!model.openApp(game.packageName)) onToast("Could not open ${game.label}.")
                    }.padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    AppIcon(game, size = 44)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(game.label, style = MaterialTheme.typography.titleMedium, color = Ice)
                        Text(game.packageName, style = MaterialTheme.typography.labelSmall, color = Muted)
                    }
                }
            }
        }
        item { SectionHeader("Compatibility layer") }
        item {
            GlassCard(
                modifier = Modifier.fillMaxWidth().clickable {
                    if (!model.isInstalled("com.winlator") || !model.openApp("com.winlator")) {
                        onToast("Winlator is not installed.")
                    }
                }
            ) {
                Text("Winlator", style = MaterialTheme.typography.titleMedium, color = Ice)
                Text(
                    if (model.isInstalled("com.winlator")) "Windows compatibility layer installed"
                    else "Install Winlator to run Windows games",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Muted
                )
            }
        }
        item { SectionHeader("Cloud gaming") }
        item { CloudLink("Xbox Cloud Gaming", "https://www.xbox.com/play") }
        item { CloudLink("GeForce NOW", "https://play.geforcenow.com") }
        item { CloudLink("Amazon Luna", "https://luna.amazon.com") }
        item { CloudLink("Boosteroid", "https://boosteroid.com") }
        item { SectionHeader("Performance") }
        item {
            GlassCard(modifier = Modifier.fillMaxWidth()) {
                Text("Display", style = MaterialTheme.typography.titleMedium, color = Ice)
                Text(
                    String.format(java.util.Locale.US, "%.0f Hz refresh rate", refreshRate),
                    style = MaterialTheme.typography.bodyMedium,
                    color = Muted
                )
                Spacer(Modifier.height(8.dp))
                Text("Memory", style = MaterialTheme.typography.titleMedium, color = Ice)
                Text(
                    "${model.device?.ramFreeMb ?: 0} MB available",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Muted
                )
                Spacer(Modifier.height(8.dp))
                Text("Thermals", style = MaterialTheme.typography.titleMedium, color = Ice)
                Text(
                    "Android does not expose per-game thermal data to a launcher without privileged access. No profile is claimed here.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Muted
                )
            }
        }
    }
}

@Composable
private fun CloudLink(title: String, url: String) {
    val context = LocalContext.current
    GlassCard(modifier = Modifier.fillMaxWidth().clickable { openUrl(context, url) }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = Ice, modifier = Modifier.weight(1f))
            Text("WEB", style = MaterialTheme.typography.labelSmall, color = Cyan)
        }
    }
}
