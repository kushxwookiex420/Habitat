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

class Habitat3DSurface(ctx:Context):GLSurfaceView(ctx){
    private val renderer=Renderer()
    init{setEGLContextClientVersion(2);setRenderer(renderer);renderMode=RENDERMODE_CONTINUOUSLY}
    fun setMode(m:Int){renderer.mode=m}

    private class Renderer:GLSurfaceView.Renderer{
        var mode=0
        private var rot=0f
        private var w=1;private var h=1
        private var program=0;private var pos=0;private var mvp=0;private var color=0;private var sizeLoc=0
        private lateinit var brain:FloatBuffer
        private lateinit var inner:FloatBuffer
        private lateinit var stars:FloatBuffer
        private lateinit var neural:FloatBuffer
        private lateinit var rings:FloatBuffer

        override fun onSurfaceCreated(gl:GL10?,config:EGLConfig?){
            GLES20.glClearColor(.001f,.003f,.018f,1f)
            GLES20.glEnable(GLES20.GL_DEPTH_TEST)
            GLES20.glEnable(GLES20.GL_BLEND)
            GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA,GLES20.GL_ONE_MINUS_SRC_ALPHA)

            val vs="""
                attribute vec3 a;
                uniform mat4 u;
                uniform float size;
                void main(){gl_Position=u*vec4(a,1.0);gl_PointSize=size;}
            """.trimIndent()
            val fs="""
                precision mediump float;
                uniform vec4 c;
                void main(){
                    float d=distance(gl_PointCoord,vec2(.5));
                    if(d>.5) discard;
                    float glow=1.0-smoothstep(.02,.5,d);
                    gl_FragColor=vec4(c.rgb,c.a*(.25+.75*glow));
                }
            """.trimIndent()
            program=GLES20.glCreateProgram()
            GLES20.glAttachShader(program,shader(GLES20.GL_VERTEX_SHADER,vs))
            GLES20.glAttachShader(program,shader(GLES20.GL_FRAGMENT_SHADER,fs))
            GLES20.glLinkProgram(program)
            pos=GLES20.glGetAttribLocation(program,"a")
            mvp=GLES20.glGetUniformLocation(program,"u")
            color=GLES20.glGetUniformLocation(program,"c")
            sizeLoc=GLES20.glGetUniformLocation(program,"size")

            val rnd=Random(42)
            val b=ArrayList<Float>();val inn=ArrayList<Float>();val st=ArrayList<Float>()
            // Two unmistakable 3D hemispheres with a central fissure and folded cortical surface.
            repeat(9000){
                val side=if(it and 1==0)-1f else 1f
                val theta=rnd.nextFloat()*PI.toFloat()
                val phi=rnd.nextFloat()*(2f*PI.toFloat())
                val fold=1f+0.075f*sin(theta*18f+phi*2.4f)+0.045f*sin(phi*13f-theta*7f)
                val y=1.30f*cos(theta)*fold
                val z=.88f*sin(theta)*sin(phi)*fold
                val localX=.78f*sin(theta)*cos(phi)*fold
                val x=side*(.30f+abs(localX))
                b.add(x);b.add(y);b.add(z)
            }
            // Inner glowing neural volume.
            repeat(2600){
                val side=if(it and 1==0)-1f else 1f
                val theta=rnd.nextFloat()*PI.toFloat()
                val phi=rnd.nextFloat()*2f*PI.toFloat()
                val rad=.15f+.60f*rnd.nextFloat()
                inn.add(side*(.25f+.48f*sin(theta)*cos(phi)*rad))
                inn.add(1.05f*cos(theta)*rad)
                inn.add(.70f*sin(theta)*sin(phi)*rad)
            }
            repeat(1100){
                st.add((rnd.nextFloat()-.5f)*12f);st.add((rnd.nextFloat()-.5f)*8f);st.add((rnd.nextFloat()-.5f)*9f)
            }

            // Curved neural pathways threading around the brain.
            val n=ArrayList<Float>()
            repeat(55){k->
                val phase=rnd.nextFloat()*6.28f
                val side=if(k%2==0)-1f else 1f
                var prevX=0f;var prevY=0f;var prevZ=0f
                repeat(22){j->
                    val t=j/21f
                    val y=(t-.5f)*2.15f
                    val z=.62f*sin(t*PI*2f+phase)+.15f*sin(t*PI*7f)
                    val x=side*(.34f+.40f*sin(t*PI)+.08f*sin(t*PI*9f+phase))
                    if(j>0){n.add(prevX);n.add(prevY);n.add(prevZ);n.add(x);n.add(y);n.add(z)}
                    prevX=x;prevY=y;prevZ=z
                }
            }

            // Three-dimensional orbital rings around the core.
            val rg=ArrayList<Float>()
            repeat(3){axis->
                repeat(181){i->
                    val a=i/180f*2f*PI.toFloat()
                    val rr=1.72f
                    val x=when(axis){0->0f else rr*cos(a)}
                    val y=when(axis){1->0f else rr*sin(a)}
                    val z=when(axis){0->rr*sin(a) else rr*cos(a)}
                    rg.add(x);rg.add(y);rg.add(z)
                    if(i>0){
                        // duplicate segment endpoints for GL_LINES
                    }
                }
            }

            brain=buffer(b);inner=buffer(inn);stars=buffer(st);neural=buffer(n);rings=buffer(rg)
        }

        private fun buffer(a:ArrayList<Float>):FloatBuffer=
            ByteBuffer.allocateDirect(a.size*4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply{a.forEach{put(it)};position(0)}

        private fun shader(type:Int,src:String):Int{
            val s=GLES20.glCreateShader(type);GLES20.glShaderSource(s,src);GLES20.glCompileShader(s);return s
        }

        override fun onSurfaceChanged(gl:GL10?,ww:Int,hh:Int){w=ww;h=hh;GLES20.glViewport(0,0,w,h)}

        override fun onDrawFrame(gl:GL10?){
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
            val p=FloatArray(16);val v=FloatArray(16);val m=FloatArray(16);val mv=FloatArray(16);val out=FloatArray(16)
            Matrix.perspectiveM(p,0,47f,w.toFloat()/h.toFloat(),.5f,40f)
            Matrix.setLookAtM(v,0,0f,.05f,6.3f,0f,0f,0f,0f,1f,0f)
            Matrix.setIdentityM(m,0)
            Matrix.rotateM(m,0,rot,0f,1f,0f)
            Matrix.rotateM(m,0,3f*sin(rot*.45f),1f,0f,0f)
            val pulse=.94f+.10f*sin(rot*.055f)
            Matrix.multiplyMM(mv,0,v,0,m,0);Matrix.multiplyMM(out,0,p,0,mv,0)

            GLES20.glUseProgram(program)
            GLES20.glUniformMatrix4fv(mvp,1,false,out,0)
            GLES20.glEnableVertexAttribArray(pos)

            // Galaxy field
            GLES20.glVertexAttribPointer(pos,3,GLES20.GL_FLOAT,false,0,stars)
            GLES20.glUniform4f(color,.10f,.28f,.75f,.35f);GLES20.glUniform1f(sizeLoc,2.2f)
            GLES20.glDrawArrays(GLES20.GL_POINTS,0,stars.capacity()/3)

            // Orbiting holographic rings
            GLES20.glVertexAttribPointer(pos,3,GLES20.GL_FLOAT,false,0,rings)
            GLES20.glUniform4f(color,.08f,.70f,1f,.28f);GLES20.glUniform1f(sizeLoc,1f)
            GLES20.glDrawArrays(GLES20.GL_LINE_STRIP,0,rings.capacity()/3)

            // Neural pathways
            GLES20.glVertexAttribPointer(pos,3,GLES20.GL_FLOAT,false,0,neural)
            GLES20.glUniform4f(color,.15f,.78f,1f,.52f);GLES20.glUniform1f(sizeLoc,2f)
            GLES20.glDrawArrays(GLES20.GL_LINES,0,neural.capacity()/3)

            // Brain shell and luminous interior
            GLES20.glVertexAttribPointer(pos,3,GLES20.GL_FLOAT,false,0,brain)
            GLES20.glUniform4f(color,.16f,.86f,1f,if(mode==0).92f else 1f);GLES20.glUniform1f(sizeLoc,5.1f*pulse)
            GLES20.glDrawArrays(GLES20.GL_POINTS,0,brain.capacity()/3)

            GLES20.glVertexAttribPointer(pos,3,GLES20.GL_FLOAT,false,0,inner)
            GLES20.glUniform4f(color,.40f,.95f,1f,.42f);GLES20.glUniform1f(sizeLoc,3.1f)
            GLES20.glDrawArrays(GLES20.GL_POINTS,0,inner.capacity()/3)

            rot+=.22f
        }
    }
}
