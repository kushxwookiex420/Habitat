package com.habitat.launcher.ui.components

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.core.graphics.drawable.toBitmap
import androidx.compose.runtime.remember
import com.habitat.launcher.data.InstalledApp
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.habitat.launcher.R
import com.habitat.launcher.ui.theme.Cyan
import com.habitat.launcher.ui.theme.Danger
import com.habitat.launcher.ui.theme.Good
import com.habitat.launcher.ui.theme.Ice
import com.habitat.launcher.ui.theme.Muted
import com.habitat.launcher.ui.theme.SurfaceNavy
import com.habitat.launcher.ui.theme.Turquoise
import com.habitat.launcher.ui.theme.Void
import com.habitat.launcher.ui.theme.Warning

@Composable
fun LauncherBackdrop() {
    Box(Modifier.fillMaxSize().background(Void)) {
        Image(
            painter = painterResource(R.drawable.space_bg),
            contentDescription = null,
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Crop,
            alpha = 0.55f
        )
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(
                    0f to Color(0xE603060B),
                    0.35f to Color(0x99050B14),
                    1f to Color(0xF203060B)
                )
            )
        )
    }
}

@Composable
fun GlassCard(
    modifier: Modifier = Modifier,
    accent: Color = Cyan,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(22.dp))
            .background(SurfaceNavy)
            .border(1.dp, accent.copy(alpha = 0.18f), RoundedCornerShape(22.dp))
            .padding(18.dp),
        content = content
    )
}

@Composable
fun SectionHeader(title: String, subtitle: String? = null, trailing: @Composable (() -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text(title.uppercase(), style = androidx.compose.material3.MaterialTheme.typography.labelLarge, color = Turquoise)
            if (subtitle != null) {
                Spacer(Modifier.height(2.dp))
                Text(
                    subtitle,
                    style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
                    color = Muted,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
        trailing?.invoke()
    }
}

@Composable
fun StatusPill(text: String, tone: Color = Cyan) {
    Row(
        modifier = Modifier
            .clip(CircleShape)
            .background(tone.copy(alpha = 0.10f))
            .border(1.dp, tone.copy(alpha = 0.28f), CircleShape)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp)
    ) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(tone))
        Text(text, style = androidx.compose.material3.MaterialTheme.typography.labelSmall, color = Ice, maxLines = 1)
    }
}

fun toneFor(status: String): Color = when (status.lowercase()) {
    "pass", "available", "verified", "ok", "online" -> Good
    "blocked", "failed", "error", "offline" -> Danger
    "running", "queued", "delegated", "pending" -> Warning
    else -> Muted
}

@Composable
fun AppIcon(app: InstalledApp, size: Int = 44, modifier: Modifier = Modifier) {
    val bitmap = remember(app.packageName, app.icon) {
        runCatching { app.icon?.toBitmap(size * 2, size * 2)?.asImageBitmap() }.getOrNull()
    }
    val shape = RoundedCornerShape((size * 0.28f).dp)
    if (bitmap != null) {
        Image(
            bitmap = bitmap,
            contentDescription = app.label,
            modifier = modifier.size(size.dp).clip(shape),
            contentScale = ContentScale.Fit
        )
    } else {
        Box(
            modifier
                .size(size.dp)
                .clip(shape)
                .background(Color(0xFF122033))
                .border(1.dp, Cyan.copy(alpha = 0.25f), shape),
            contentAlignment = Alignment.Center
        ) {
            Text(app.label.take(1).uppercase(), color = Cyan, style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
        }
    }
}

fun openUrl(context: Context, url: String): Boolean = runCatching {
    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    true
}.getOrDefault(false)

fun openSystemSetting(context: Context, action: String): Boolean = runCatching {
    context.startActivity(Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    true
}.getOrDefault(false)

@Composable
fun EmptyState(title: String, body: String) {
    GlassCard(modifier = Modifier.fillMaxWidth()) {
        Text(title, style = androidx.compose.material3.MaterialTheme.typography.titleMedium, color = Ice)
        Spacer(Modifier.height(6.dp))
        Text(body, style = androidx.compose.material3.MaterialTheme.typography.bodyMedium, color = Muted)
    }
}
