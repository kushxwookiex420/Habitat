package com.habitat

import android.content.Context
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.opengl.Matrix
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.*
import kotlin.random.Random

class Habitat3DSurface(ctx: Context) : GLSurfaceView(ctx) {
    private val renderer = Renderer()
    init {
        setEGLContextClientVersion(2)
        setRenderer(renderer)
        renderMode = RENDERMODE_CONTINUOUSLY
    }
    fun setMode(m: Int) { renderer.mode = m }

    private class Renderer : GLSurfaceView.Renderer {
        var mode = 0
        private var rot = 0f
        private var w = 1
        private var h = 1
        private var pointProgram = 0
        private var meshProgram = 0
        private var pos = 0
        private var mvp = 0
        private var color = 0
        private var sizeLoc = 0
        private var meshPos = 0
        private var meshMvp = 0
        private var meshColor = 0
        private var brain: FloatBuffer
        private var gyri: FloatBuffer
        private var inner: FloatBuffer
        private var stars: FloatBuffer
        private var neural: FloatBuffer
        private var rings: FloatBuffer
        private var brainCount = 0
        private var gyriCount = 0
        private var innerCount = 0
        private var starsCount = 0
        private var neuralCount = 0
        private var ringsCount = 0
        private val rnd = Random(71)

        init {
            brain = empty()
            gyri = empty()
            inner = empty()
            stars = empty()
            neural = empty()
            rings = empty()
        }

        override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
            GLES20.glClearColor(.001f, .002f, .012f, 1f)
            GLES20.glEnable(GLES20.GL_DEPTH_TEST)
            GLES20.glEnable(GLES20.GL_BLEND)
            GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA)

            val pointVs = """
                attribute vec3 a;
                uniform mat4 u;
                uniform float size;
                void main(){ gl_Position=u*vec4(a,1.0); gl_PointSize=size; }
            """.trimIndent()
            val pointFs = """
                precision mediump float;
                uniform vec4 c;
                void main(){
                    float d=distance(gl_PointCoord,vec2(.5));
                    if(d>.5) discard;
                    float glow=1.0-smoothstep(.02,.5,d);
                    gl_FragColor=vec4(c.rgb,c.a*(.18+.82*glow));
                }
            """.trimIndent()
            pointProgram = program(pointVs, pointFs)
            pos = GLES20.glGetAttribLocation(pointProgram, "a")
            mvp = GLES20.glGetUniformLocation(pointProgram, "u")
            color = GLES20.glGetUniformLocation(pointProgram, "c")
            sizeLoc = GLES20.glGetUniformLocation(pointProgram, "size")

            val meshVs = """
                attribute vec3 a;
                uniform mat4 u;
                void main(){ gl_Position=u*vec4(a,1.0); }
            """.trimIndent()
            val meshFs = """
                precision mediump float;
                uniform vec4 c;
                void main(){ gl_FragColor=c; }
            """.trimIndent()
            meshProgram = program(meshVs, meshFs)
            meshPos = GLES20.glGetAttribLocation(meshProgram, "a")
            meshMvp = GLES20.glGetUniformLocation(meshProgram, "u")
            meshColor = GLES20.glGetUniformLocation(meshProgram, "c")

            val b = ArrayList<Float>()
            val g = ArrayList<Float>()
            val inn = ArrayList<Float>()
            val st = ArrayList<Float>()
            val n = ArrayList<Float>()
            val rg = ArrayList<Float>()

            // Anatomical-looking 3D cortical shell: two hemispheres, deep center fissure,
            // asymmetric folds, and a real rounded silhouette.
            val latSteps = 46
            val lonSteps = 72
            for (sideI in 0..1) {
                val side = if (sideI == 0) -1f else 1f
                for (la in 0 until latSteps) {
                    val t0 = la.toFloat() / (latSteps - 1)
                    val t1 = (la + 1).toFloat() / (latSteps - 1)
                    val y0 = 1.34f * (t0 * 2f - 1f)
                    val y1 = 1.34f * (t1 * 2f - 1f)
                    val r0 = sin(t0 * PI).toFloat()
                    val r1 = sin(t1 * PI).toFloat()
                    for (lo in 0 until lonSteps) {
                        val p0 = lo.toFloat() / lonSteps * 2f * PI.toFloat()
                        val p1 = (lo + 1).toFloat() / lonSteps * 2f * PI.toFloat()
                        fun vertex(y: Float, r: Float, p: Float): FloatArray {
                            val fold = 1f + .045f*sin(p*10f + y*9f) + .035f*sin(p*19f - y*6f)
                            val x = side*(.28f + .72f*r*cos(p)*fold)
                            val z = .82f*r*sin(p)*fold
                            return floatArrayOf(x, y, z)
                        }
                        val v00=vertex(y0,r0,p0); val v10=vertex(y1,r1,p0)
                        val v01=vertex(y0,r0,p1); val v11=vertex(y1,r1,p1)
                        fun tri(a:FloatArray,bv:FloatArray,c:FloatArray){
                            b.add(a[0]);b.add(a[1]);b.add(a[2])
                            b.add(bv[0]);b.add(bv[1]);b.add(bv[2])
                            b.add(c[0]);b.add(c[1]);b.add(c[2])
                        }
                        tri(v00,v10,v01); tri(v01,v10,v11)
                    }
                }
            }
            brainCount=b.size/3

            // Dense glowing cortical points reinforce the hologram and folds.
            repeat(6200) {
                val side=if(it and 1==0)-1f else 1f
                val y=(rnd.nextFloat()*2f-1f)*1.30f
                val rr=sqrt(max(0f,1f-(y/1.34f)*(y/1.34f)))
                val p=rnd.nextFloat()*2f*PI.toFloat()
                val fold=1f+.055f*sin(p*11f+y*8f)+.035f*sin(p*21f-y*5f)
                g.add(side*(.30f+.72f*rr*cos(p)*fold));g.add(y);g.add(.83f*rr*sin(p)*fold)
            }
            gyriCount=g.size/3

            repeat(1700) {
                val side=if(it and 1==0)-1f else 1f
                val a=rnd.nextFloat()*PI.toFloat()
                val p=rnd.nextFloat()*2f*PI.toFloat()
                val r=.08f+.55f*rnd.nextFloat()
                inn.add(side*(.22f+.43f*sin(a)*cos(p)*r))
                inn.add(1.05f*cos(a)*r)
                inn.add(.60f*sin(a)*sin(p)*r)
            }
            innerCount=inn.size/3

            repeat(950) {
                st.add((rnd.nextFloat()-.5f)*12f);st.add((rnd.nextFloat()-.5f)*8f);st.add((rnd.nextFloat()-.5f)*9f)
            }
            starsCount=st.size/3

            // Fine neural arcs.
            repeat(85) { k ->
                val side=if(k%2==0)-1f else 1f
                val phase=rnd.nextFloat()*6.28f
                var px=0f;var py=0f;var pz=0f
                repeat(25) { j ->
                    val t=j/24f
                    val y=(t-.5f)*2.45f
                    val z=.62f*sin(t*PI.toFloat()*2f+phase)+.12f*sin(t*PI.toFloat()*9f)
                    val x=side*(.30f+.50f*sin(t*PI.toFloat())+.06f*sin(t*PI.toFloat()*13f+phase))
                    if(j>0){n.add(px);n.add(py);n.add(pz);n.add(x);n.add(y);n.add(z)}
                    px=x;py=y;pz=z
                }
            }
            neuralCount=n.size/3

            // Three clean orbital rings, each drawn separately to avoid connector artifacts.
            for(axis in 0..2){
                for(i in 0..160){
                    val a=i/160f*2f*PI.toFloat()
                    val rr=1.72f
                    when(axis){
                        0->{rg.add(0f);rg.add(rr*cos(a));rg.add(rr*sin(a))}
                        1->{rg.add(rr*cos(a));rg.add(0f);rg.add(rr*sin(a))}
                        else->{rg.add(rr*cos(a));rg.add(rr*sin(a));rg.add(0f)}
                    }
                }
            }
            ringsCount=rg.size/3

            brain=buffer(b);gyri=buffer(g);inner=buffer(inn);stars=buffer(st);neural=buffer(n);rings=buffer(rg)
        }

        private fun empty():FloatBuffer=ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder()).asFloatBuffer()
        private fun buffer(a:ArrayList<Float>):FloatBuffer=ByteBuffer.allocateDirect(a.size*4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply{a.forEach{put(it)};position(0)}
        private fun shader(type:Int,src:String):Int{
            val s=GLES20.glCreateShader(type);GLES20.glShaderSource(s,src);GLES20.glCompileShader(s);return s
        }
        private fun program(v:String,f:String):Int{
            val p=GLES20.glCreateProgram();GLES20.glAttachShader(p,shader(GLES20.GL_VERTEX_SHADER,v));GLES20.glAttachShader(p,shader(GLES20.GL_FRAGMENT_SHADER,f));GLES20.glLinkProgram(p);return p
        }

        override fun onSurfaceChanged(gl:GL10?,ww:Int,hh:Int){w=ww;h=hh;GLES20.glViewport(0,0,w,h)}

        override fun onDrawFrame(gl:GL10?){
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
            val p=FloatArray(16);val v=FloatArray(16);val m=FloatArray(16);val mv=FloatArray(16);val out=FloatArray(16)
            Matrix.perspectiveM(p,0,44f,w.toFloat()/h.toFloat(),.4f,40f)
            Matrix.setLookAtM(v,0,0f,.0f,6.1f,0f,0f,0f,0f,1f,0f)
            Matrix.setIdentityM(m,0)
            Matrix.rotateM(m,0,rot,0f,1f,0f)
            Matrix.rotateM(m,0,7f*sin(rot*.20f),1f,0f,0f)
            val pulse=.94f+.08f*sin(rot*.055f)
            Matrix.scaleM(m,0,pulse,pulse,pulse)
            Matrix.multiplyMM(mv,0,v,0,m,0);Matrix.multiplyMM(out,0,p,0,mv,0)

            GLES20.glUseProgram(pointProgram)
            GLES20.glUniformMatrix4fv(mvp,1,false,out,0)
            GLES20.glEnableVertexAttribArray(pos)

            GLES20.glVertexAttribPointer(pos,3,GLES20.GL_FLOAT,false,0,stars)
            GLES20.glUniform4f(color,.12f,.32f,.82f,.32f);GLES20.glUniform1f(sizeLoc,2.1f)
            GLES20.glDrawArrays(GLES20.GL_POINTS,0,starsCount)

            GLES20.glVertexAttribPointer(pos,3,GLES20.GL_FLOAT,false,0,rings)
            GLES20.glUniform4f(color,.08f,.74f,1f,.34f);GLES20.glUniform1f(sizeLoc,2f)
            for(i in 0..2) GLES20.glDrawArrays(GLES20.GL_LINE_STRIP,i*161,161)

            GLES20.glVertexAttribPointer(pos,3,GLES20.GL_FLOAT,false,0,neural)
            GLES20.glUniform4f(color,.12f,.82f,1f,.44f);GLES20.glUniform1f(sizeLoc,2.2f)
            GLES20.glDrawArrays(GLES20.GL_LINES,0,neuralCount)

            // Soft inner core.
            GLES20.glVertexAttribPointer(pos,3,GLES20.GL_FLOAT,false,0,inner)
            GLES20.glUniform4f(color,.36f,.95f,1f,.34f);GLES20.glUniform1f(sizeLoc,4.0f)
            GLES20.glDrawArrays(GLES20.GL_POINTS,0,innerCount)

            // Anatomical shell.
            GLES20.glUseProgram(meshProgram)
            GLES20.glUniformMatrix4fv(meshMvp,1,false,out,0)
            GLES20.glEnableVertexAttribArray(meshPos)
            GLES20.glVertexAttribPointer(meshPos,3,GLES20.GL_FLOAT,false,0,brain)
            GLES20.glUniform4f(meshColor,.05f,.68f,.92f,.20f)
            GLES20.glDrawArrays(GLES20.GL_TRIANGLES,0,brainCount)

            // Bright cortical contour points over the shell.
            GLES20.glUseProgram(pointProgram)
            GLES20.glUniformMatrix4fv(mvp,1,false,out,0)
            GLES20.glVertexAttribPointer(pos,3,GLES20.GL_FLOAT,false,0,gyri)
            GLES20.glUniform4f(color,.18f,.88f,1f,if(mode==0).92f else .82f)
            GLES20.glUniform1f(sizeLoc,3.5f)
            GLES20.glDrawArrays(GLES20.GL_POINTS,0,gyriCount)

            // Central fissure highlight.
            GLES20.glUniform4f(color,.55f,1f,1f,.75f)
            GLES20.glUniform1f(sizeLoc,2.4f)
            rot+=.115f
        }
    }
}
