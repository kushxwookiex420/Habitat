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
    private val r=Renderer()
    init{setEGLContextClientVersion(2);setRenderer(r);renderMode=RENDERMODE_CONTINUOUSLY}
    fun setMode(m:Int){r.mode=m}
    private class Renderer:GLSurfaceView.Renderer{
        var mode=0;private var rot=0f;private var w=1;private var h=1
        private var program=0;private var pos=0;private var mvp=0;private var color=0
        private lateinit var brain:FloatBuffer
        private lateinit var stars:FloatBuffer
        override fun onSurfaceCreated(gl:GL10?,c:EGLConfig?){
            GLES20.glClearColor(.002f,.004f,.025f,1f)
            GLES20.glEnable(GLES20.GL_DEPTH_TEST);GLES20.glEnable(GLES20.GL_BLEND)
            GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA,GLES20.GL_ONE_MINUS_SRC_ALPHA)
            val vs="attribute vec3 a;uniform mat4 u;uniform float size;void main(){gl_Position=u*vec4(a,1.0);gl_PointSize=size;}"
            val fs="precision mediump float;uniform vec4 c;void main(){float d=distance(gl_PointCoord,vec2(.5));if(d>.5)discard;float g=1.0-smoothstep(.05,.5,d);gl_FragColor=vec4(c.rgb,c.a*g);}"
            program=GLES20.glCreateProgram();GLES20.glAttachShader(program,shader(GLES20.GL_VERTEX_SHADER,vs));GLES20.glAttachShader(program,shader(GLES20.GL_FRAGMENT_SHADER,fs));GLES20.glLinkProgram(program)
            pos=GLES20.glGetAttribLocation(program,"a");mvp=GLES20.glGetUniformLocation(program,"u");color=GLES20.glGetUniformLocation(program,"c")
            val size=GLES20.glGetUniformLocation(program,"size")
            val rnd=Random(7);val b=ArrayList<Float>();val st=ArrayList<Float>()
            repeat(5200){
                val side=if(it%2==0)-1f else 1f
                val y=rnd.nextFloat()*2f-1f;val z=rnd.nextFloat()*2f-1f
                val shell=sqrt(max(0f,1f-y*y))
                val x=side*(.43f+.62f*shell)*(0.78f+0.22f*rnd.nextFloat())
                b.add(x);b.add(y*1.15f);b.add(z*.78f)
            }
            repeat(900){st.add((rnd.nextFloat()-.5f)*10f);st.add((rnd.nextFloat()-.5f)*7f);st.add((rnd.nextFloat()-.5f)*8f)}
            brain=buffer(b);stars=buffer(st)
            GLES20.glUseProgram(program);GLES20.glUniform1f(size,4.8f)
        }
        private fun buffer(a:ArrayList<Float>):FloatBuffer=ByteBuffer.allocateDirect(a.size*4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply{a.forEach{put(it)};position(0)}
        private fun shader(t:Int,s:String):Int{val x=GLES20.glCreateShader(t);GLES20.glShaderSource(x,s);GLES20.glCompileShader(x);return x}
        override fun onSurfaceChanged(gl:GL10?,ww:Int,hh:Int){w=ww;h=hh;GLES20.glViewport(0,0,w,h)}
        override fun onDrawFrame(gl:GL10?){
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
            val p=FloatArray(16);val v=FloatArray(16);val m=FloatArray(16);val mv=FloatArray(16);val out=FloatArray(16)
            Matrix.perspectiveM(p,0,50f,w.toFloat()/h,1f,30f);Matrix.setLookAtM(v,0,0f,0f,5.2f,0f,0f,0f,0f,1f,0f)
            Matrix.setIdentityM(m,0);Matrix.rotateM(m,0,rot,0f,1f,0f);Matrix.rotateM(m,0,sin(rot*.012f)*3f,1f,0f,0f)
            Matrix.multiplyMM(mv,0,v,0,m,0);Matrix.multiplyMM(out,0,p,0,mv,0)
            GLES20.glUseProgram(program);GLES20.glUniformMatrix4fv(mvp,1,false,out,0);GLES20.glEnableVertexAttribArray(pos);GLES20.glVertexAttribPointer(pos,3,GLES20.GL_FLOAT,false,0,stars)
            GLES20.glUniform4f(color,.12f,.35f,.8f,.28f);GLES20.glUniform1f(GLES20.glGetUniformLocation(program,"size"),2f);GLES20.glDrawArrays(GLES20.GL_POINTS,0,stars.capacity()/3)
            GLES20.glVertexAttribPointer(pos,3,GLES20.GL_FLOAT,false,0,brain)
            val pulse=.82f+.18f*sin(rot*.055f);val alpha=if(mode==1||mode==2)1f else .82f
            GLES20.glUniform4f(color,.18f,.82f,1f,alpha*pulse);GLES20.glUniform1f(GLES20.glGetUniformLocation(program,"size"),5.8f);GLES20.glDrawArrays(GLES20.GL_POINTS,0,brain.capacity()/3)
            rot+=.32f
        }
    }
}
