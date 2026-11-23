package com.habitat.launcher.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.habitat.launcher.R

val Void = Color(0xFF03060B)
val DeepNavy = Color(0xFF070D18)
val SurfaceNavy = Color(0xE60A1322)
val SurfaceRaised = Color(0xF20E1A2C)
val Cyan = Color(0xFF22D3EE)
val Turquoise = Color(0xFF2DD4BF)
val Ice = Color(0xFFE6F6FB)
val Muted = Color(0xFF8FA6B8)
val Warning = Color(0xFFF5C56B)
val Danger = Color(0xFFFF7A7A)
val Good = Color(0xFF5EEAD4)

val SpaceFamily = FontFamily(Font(R.font.space_grotesk, FontWeight.Normal))

private val LauncherTypography = Typography(
    displayLarge = TextStyle(fontFamily = SpaceFamily, fontWeight = FontWeight.Light, fontSize = 52.sp, letterSpacing = (-1.4).sp),
    displaySmall = TextStyle(fontFamily = SpaceFamily, fontWeight = FontWeight.Light, fontSize = 30.sp, letterSpacing = (-0.6).sp),
    headlineMedium = TextStyle(fontFamily = SpaceFamily, fontWeight = FontWeight.Medium, fontSize = 24.sp, letterSpacing = (-0.3).sp),
    titleLarge = TextStyle(fontFamily = SpaceFamily, fontWeight = FontWeight.Medium, fontSize = 20.sp),
    titleMedium = TextStyle(fontFamily = SpaceFamily, fontWeight = FontWeight.Medium, fontSize = 16.sp, letterSpacing = 0.2.sp),
    bodyLarge = TextStyle(fontFamily = SpaceFamily, fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontFamily = SpaceFamily, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 19.sp),
    labelLarge = TextStyle(fontFamily = SpaceFamily, fontWeight = FontWeight.Medium, fontSize = 12.sp, letterSpacing = 1.1.sp),
    labelSmall = TextStyle(fontFamily = SpaceFamily, fontWeight = FontWeight.Medium, fontSize = 10.sp, letterSpacing = 1.6.sp)
)

private val LauncherColors = darkColorScheme(
    primary = Cyan,
    onPrimary = Void,
    secondary = Turquoise,
    onSecondary = Void,
    background = Void,
    onBackground = Ice,
    surface = DeepNavy,
    onSurface = Ice,
    surfaceVariant = SurfaceNavy,
    onSurfaceVariant = Muted,
    outline = Color(0x5522D3EE),
    error = Danger
)

@Composable
fun HabitatLauncherTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = LauncherColors, typography = LauncherTypography, content = content)
}
