package com.habitat.launcher.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.habitat.launcher.R
import com.habitat.launcher.ui.theme.Cyan
import com.habitat.launcher.ui.theme.Turquoise
import kotlin.math.cos
import kotlin.math.sin

@Composable
fun NeuralBrain(modifier: Modifier = Modifier, size: Int = 260) {
    val transition = rememberInfiniteTransition(label = "neural")
    val pulse by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(3600, easing = LinearEasing), RepeatMode.Restart),
        label = "pulse"
    )
    val shimmer by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(7200, easing = LinearEasing), RepeatMode.Reverse),
        label = "shimmer"
    )

    Box(modifier = modifier.size(size.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val center = Offset(this.size.width / 2f, this.size.height / 2f)
            val min = this.size.minDimension
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(Cyan.copy(alpha = 0.20f), Color.Transparent),
                    center = center,
                    radius = min * 0.55f
                ),
                radius = min * 0.55f,
                center = center
            )
            repeat(3) { ring ->
                val progress = (pulse + ring / 3f) % 1f
                drawCircle(
                    color = Cyan.copy(alpha = (1f - progress) * 0.28f),
                    radius = min * (0.30f + progress * 0.24f),
                    center = center,
                    style = Stroke(width = 1.2f)
                )
            }
            repeat(14) { index ->
                val angle = (index / 14f) * 6.28318f + shimmer * 0.35f
                val radius = min * (0.36f + 0.05f * sin(index * 1.7f))
                drawCircle(
                    color = if (index % 3 == 0) Turquoise.copy(alpha = 0.55f) else Cyan.copy(alpha = 0.35f),
                    radius = 1.8f,
                    center = Offset(center.x + cos(angle) * radius, center.y + sin(angle) * radius)
                )
            }
        }
        Image(
            painter = painterResource(R.drawable.ax_brain),
            contentDescription = "AX neural core",
            modifier = Modifier
                .size((size * 0.72f).dp)
                .clip(CircleShape)
                .border(1.dp, Cyan.copy(alpha = 0.35f), CircleShape),
            contentScale = ContentScale.Crop
        )
    }
}
