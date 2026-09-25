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
        private var spin = 0f
        private var w = 1
        private var h = 1

        private var meshProgram = 0
        private var lineProgram = 0
        private var pointProgram = 0

        private var meshPos = 0
        private var meshMvp = 0
        private var meshColor = 0
        private var meshLight = 0

        private var linePos = 0
        private var lineMvp = 0
        private var lineColor = 0

        private var pointPos = 0
        private var pointMvp = 0
        private var pointColor = 0
        private var pointSize = 0

        private var brain: FloatBuffer = empty()
        private var gyri: FloatBuffer = empty()
        private var grooves: FloatBuffer = empty()
        private var cerebellum: FloatBuffer = empty()
        private var neural: FloatBuffer = empty()
        private var stars: FloatBuffer = empty()
        private var rings: FloatBuffer = empty()

        private var brainCount = 0
        private var gyriCount = 0
        private var groovesCount = 0
        private var cerebellumCount = 0
        private var neuralCount = 0
        private var starsCount = 0

        private val rnd = Random(77)

        override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
            GLES20.glClearColor(.001f, .003f, .014f, 1f)
            GLES20.glEnable(GLES20.GL_DEPTH_TEST)
            GLES20.glEnable(GLES20.GL_BLEND)
            GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA)

            val meshVs = """
                attribute vec3 a;
                uniform mat4 u;
                uniform float light;
                varying vec3 n;
                varying vec3 p;
                void main(){
                    p=a;
                    vec3 q=normalize(vec3(a.x/(1.16*1.16),a.y/(1.34*1.34),a.z/(.88*.88)));
                    n=q;
                    gl_Position=u*vec4(a,1.0);
                }
            """.trimIndent()
            val meshFs = """
                precision mediump float;
                uniform vec4 c;
                uniform float light;
                varying vec3 n;
                varying vec3 p;
                void main(){
                    vec3 L=normalize(vec3(-.35,.65,1.0));
                    vec3 V=normalize(vec3(0.0,0.0,1.0));
                    float d=max(dot(normalize(n),L),0.0);
                    float rim=pow(1.0-max(dot(normalize(n),V),0.0),2.2);
                    float sheen=pow(max(dot(reflect(-L,normalize(n)),V),0.0),18.0);
                    vec3 rgb=c.rgb*(.30+.70*d)+vec3(.10,.45,.55)*rim+vec3(.30,.95,1.0)*sheen*.65;
                    gl_FragColor=vec4(rgb,c.a*(.72+.28*d));
                }
            """.trimIndent()
            meshProgram=program(meshVs,meshFs)
            meshPos=GLES20.glGetAttribLocation(meshProgram,"a")
            meshMvp=GLES20.glGetUniformLocation(meshProgram,"u")
            meshColor=GLES20.glGetUniformLocation(meshProgram,"c")
            meshLight=GLES20.glGetUniformLocation(meshProgram,"light")

            val lineVs="""
                attribute vec3 a;
                uniform mat4 u;
                void main(){gl_Position=u*vec4(a,1.0);}
            """.trimIndent()
            val lineFs="""
                precision mediump float;
                uniform vec4 c;
                void main(){gl_FragColor=c;}
            """.trimIndent()
            lineProgram=program(lineVs,lineFs)
            linePos=GLES20.glGetAttribLocation(lineProgram,"a")
            lineMvp=GLES20.glGetUniformLocation(lineProgram,"u")
            lineColor=GLES20.glGetUniformLocation(lineProgram,"c")

            val pointVs="""
                attribute vec3 a;
                uniform mat4 u;
                uniform float size;
                void main(){gl_Position=u*vec4(a,1.0);gl_PointSize=size;}
            """.trimIndent()
            val pointFs="""
                precision mediump float;
                uniform vec4 c;
                void main(){
                    float d=distance(gl_PointCoord,vec2(.5));
                    if(d>.5) discard;
                    float g=1.0-smoothstep(.03,.5,d);
                    gl_FragColor=vec4(c.rgb,c.a*(.12+.88*g));
                }
            """.trimIndent()
            pointProgram=program(pointVs,pointFs)
            pointPos=GLES20.glGetAttribLocation(pointProgram,"a")
            pointMvp=GLES20.glGetUniformLocation(pointProgram,"u")
            pointColor=GLES20.glGetUniformLocation(pointProgram,"c")
            pointSize=GLES20.glGetUniformLocation(pointProgram,"size")

            buildBrain()
        }

        private fun buildBrain(){
            val b=ArrayList<Float>()
            val g=ArrayList<Float>()
            val gr=ArrayList<Float>()
            val cb=ArrayList<Float>()
            val n=ArrayList<Float>()
            val s=ArrayList<Float>()
            val r=ArrayList<Float>()

            fun put(v:FloatArray){b.add(v[0]);b.add(v[1]);b.add(v[2])}
            fun vertex(side:Float,t:Float,p:Float):FloatArray{
                val rr=sin(t).toFloat()
                val y=1.34f*cos(t)
                val frontal=1f+.10f*exp(-((y-0.45f)*(y-0.45f))*1.2f)
                val occipital=1f+.08f*exp(-((y+0.55f)*(y+0.55f))*2.0f)
                val lobe=frontal*occipital
                val fold=1f+.075f*sin(p*7.0f+y*3.2f)+.035f*sin(p*15.0f-y*5.5f)+.018f*sin(p*31.0f+y*8.0f)
                val x=side*(.245f+.93f*rr*cos(p)*fold)*lobe
                val z=.91f*rr*sin(p)*fold*lobe
                val taper=.95f+.05f*cos(t)
                return floatArrayOf(x*taper,y*taper,z*taper)
            }
            val T=38
            val P=72
            for(sideI in 0..1){
                val side=if(sideI==0)-1f else 1f
                for(i in 0 until T-1){
                    val t0=PI.toFloat()*i/(T-1)
                    val t1=PI.toFloat()*(i+1)/(T-1)
                    for(j in 0 until P){
                        val p0=2f*PI.toFloat()*j/P
                        val p1=2f*PI.toFloat()*(j+1)/P
                        val a=vertex(side,t0,p0);val bb=vertex(side,t1,p0);val c=vertex(side,t0,p1);val d=vertex(side,t1,p1)
                        put(a);put(bb);put(c);put(c);put(bb);put(d)
                    }
                }
            }
            brainCount=b.size/3

            // Dense cortical surface sampling: makes the folds read as a luminous 3D structure.
            repeat(7000){
                val side=if(it%2==0)-1f else 1f
                val t=.08f+rnd.nextFloat()*(PI.toFloat()-.16f)
                val p=rnd.nextFloat()*2f*PI.toFloat()
                val v=vertex(side,t,p)
                g.add(v[0]);g.add(v[1]);g.add(v[2])
            }
            gyriCount=g.size/3

            // Dense luminous cortical texture.
            for(sideI in 0..1){
                val side=if(sideI==0)-1f else 1f
                for(k in 0 until 42){
                    val t=.16f+(k/41f)*2.78f
                    val phase=k*.61f
                    for(j in 0..90){
                        val p=2f*PI.toFloat()*j/90f
                        val tt=t+.055f*sin(p*3f+phase)+.025f*sin(p*9f-phase)
                        val v=vertex(side,tt,p)
                        g.add(v[0]*1.006f);g.add(v[1]*1.006f);g.add(v[2]*1.006f)
                    }
                }
            }
            gyriCount=g.size/3

            // Irregular groove strokes sit just above the cortex so the silhouette
            // reads as a folded human brain instead of a smooth ellipsoid.
            fun groovePoint(side:Float, u:Float, phase:Float, longitudinal:Boolean):FloatArray {
                return if (longitudinal) {
                    val t=.13f+u*2.88f
                    val p=phase+.22f*sin(u*PI.toFloat()*4f+phase)+.07f*sin(u*PI.toFloat()*13f-phase)
                    vertex(side,t,p)
                } else {
                    val p=u*2f*PI.toFloat()
                    val t=.20f+.70f*(.5f+.5f*sin(phase))+.11f*sin(p*4f+phase)
                    vertex(side,t,p)
                }
            }
            for(sideI in 0..1){
                val side=if(sideI==0)-1f else 1f
                for(k in 0 until 24){
                    val phase=(k*.47f)%(2f*PI.toFloat())
                    var last:FloatArray?=null
                    for(j in 0..72){
                        val v=groovePoint(side,j/72f,phase,true)
                        if(last!=null){
                            gr.add(last!![0]*1.014f);gr.add(last!![1]*1.014f);gr.add(last!![2]*1.014f)
                            gr.add(v[0]*1.014f);gr.add(v[1]*1.014f);gr.add(v[2]*1.014f)
                        }
                        last=v
                    }
                }
                for(k in 0 until 14){
                    val phase=k*.71f
                    var last:FloatArray?=null
                    for(j in 0..80){
                        val u=j/80f
                        val v=groovePoint(side,u,phase,false)
                        if(last!=null){
                            gr.add(last!![0]*1.012f);gr.add(last!![1]*1.012f);gr.add(last!![2]*1.012f)
                            gr.add(v[0]*1.012f);gr.add(v[1]*1.012f);gr.add(v[2]*1.012f)
                        }
                        last=v
                    }
                }
            }
            // Deep central fissure, kept subtle so the hemispheres read as one organ.
            for(j in 0..90){
                val y=-1.25f+j/90f*2.50f
                val z=.28f*sin(j/90f*PI.toFloat())
                gr.add(-.275f);gr.add(y);gr.add(z)
                gr.add(-.255f);gr.add(y+.025f);gr.add(z+.01f)
                gr.add(.275f);gr.add(y);gr.add(z)
                gr.add(.255f);gr.add(y+.025f);gr.add(z+.01f)
            }
            groovesCount=gr.size/3

            // Cerebellum: a separate small lobulated 3D mass behind the lower brain.
            fun putCb(v:FloatArray){cb.add(v[0]);cb.add(v[1]);cb.add(v[2])}
            val ct=20;val cp=40
            for(i in 0 until ct-1){
                val t0=PI.toFloat()*i/(ct-1);val t1=PI.toFloat()*(i+1)/(ct-1)
                for(j in 0 until cp){
                    val p0=2f*PI.toFloat()*j/cp;val p1=2f*PI.toFloat()*(j+1)/cp
                    fun cv(t:Float,p:Float):FloatArray{
                        val rr=sin(t);val fold=1f+.08f*sin(p*12f)
                        return floatArrayOf(.0f+.34f*rr*cos(p)*fold,-1.05f+.48f*cos(t),-.30f+.34f*rr*sin(p)*fold)
                    }
                    val a=cv(t0,p0);val bb=cv(t1,p0);val c=cv(t0,p1);val d=cv(t1,p1)
                    putCb(a);putCb(bb);putCb(c);putCb(c);putCb(bb);putCb(d)
                }
            }
            cerebellumCount=cb.size/3

            // Neural pathways, bright enough to visibly travel through the brain.
            repeat(70){k->
                val side=if(k%2==0)-1f else 1f
                val phase=rnd.nextFloat()*6.28f
                var last=floatArrayOf(0f,0f,0f)
                for(j in 0..22){
                    val t=j/22f
                    val y=(t-.5f)*2.15f
                    val x=side*(.30f+.47f*sin(t*PI.toFloat())+.08f*sin(t*PI.toFloat()*7f+phase))
                    val z=.50f*sin(t*PI.toFloat()*PI.toFloat()+phase)*(.75f+.25f*sin(t*PI.toFloat()))
                    val cur=floatArrayOf(x,y,z)
                    if(j>0){n.add(last[0]);n.add(last[1]);n.add(last[2]);n.add(cur[0]);n.add(cur[1]);n.add(cur[2])}
                    last=cur
                }
            }
            neuralCount=n.size/3

            repeat(1100){
                s.add((rnd.nextFloat()-.5f)*12f);s.add((rnd.nextFloat()-.5f)*8f);s.add((rnd.nextFloat()-.5f)*9f)
            }
            starsCount=s.size/3

            for(axis in 0..2){
                for(i in 0..160){
                    val a=2f*PI.toFloat()*i/160f;val q=1.75f
                    when(axis){
                        0->{r.add(0f);r.add(q*cos(a));r.add(q*sin(a))}
                        1->{r.add(q*cos(a));r.add(0f);r.add(q*sin(a))}
                        else->{r.add(q*cos(a));r.add(q*sin(a));r.add(0f)}
                    }
                }
            }

            brain=buffer(b);gyri=buffer(g);grooves=buffer(gr);cerebellum=buffer(cb);neural=buffer(n);stars=buffer(s);rings=buffer(r)
        }

        private fun empty():FloatBuffer=ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder()).asFloatBuffer()
        private fun buffer(a:ArrayList<Float>):FloatBuffer=ByteBuffer.allocateDirect(a.size*4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply{a.forEach{put(it)};position(0)}
        private fun shader(type:Int,src:String):Int{val s=GLES20.glCreateShader(type);GLES20.glShaderSource(s,src);GLES20.glCompileShader(s);return s}
        private fun program(v:String,f:String):Int{val p=GLES20.glCreateProgram();GLES20.glAttachShader(p,shader(GLES20.GL_VERTEX_SHADER,v));GLES20.glAttachShader(p,shader(GLES20.GL_FRAGMENT_SHADER,f));GLES20.glLinkProgram(p);return p}

        override fun onSurfaceChanged(gl:GL10?,ww:Int,hh:Int){w=ww;h=hh;GLES20.glViewport(0,0,w,h)}

        override fun onDrawFrame(gl:GL10?){
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
            val proj=FloatArray(16);val view=FloatArray(16);val model=FloatArray(16);val mv=FloatArray(16);val out=FloatArray(16)
            Matrix.perspectiveM(proj,0,42f,w.toFloat()/h.toFloat(),.35f,40f)
            Matrix.setLookAtM(view,0,0f,.05f,6.25f,0f,0f,0f,0f,1f,0f)
            Matrix.setIdentityM(model,0)
            Matrix.rotateM(model,0,spin,0f,1f,0f)
            Matrix.rotateM(model,0,8f*sin(spin*.17f),1f,0f,0f)
            val pulse=.96f+.045f*sin(spin*.055f)
            Matrix.scaleM(model,0,pulse,pulse,pulse)
            Matrix.multiplyMM(mv,0,view,0,model,0);Matrix.multiplyMM(out,0,proj,0,mv,0)

            GLES20.glUseProgram(pointProgram)
            GLES20.glUniformMatrix4fv(pointMvp,1,false,out,0)
            GLES20.glEnableVertexAttribArray(pointPos)
            GLES20.glVertexAttribPointer(pointPos,3,GLES20.GL_FLOAT,false,0,stars)
            GLES20.glUniform4f(pointColor,.10f,.38f,.95f,.38f);GLES20.glUniform1f(pointSize,2.0f)
            GLES20.glDrawArrays(GLES20.GL_POINTS,0,starsCount)

            GLES20.glUseProgram(lineProgram)
            GLES20.glUniformMatrix4fv(lineMvp,1,false,out,0)
            GLES20.glEnableVertexAttribArray(linePos)
            GLES20.glVertexAttribPointer(linePos,3,GLES20.GL_FLOAT,false,0,rings)
            GLES20.glUniform4f(lineColor,.08f,.75f,1f,.28f)
            for(i in 0..2)GLES20.glDrawArrays(GLES20.GL_LINE_STRIP,i*161,161)

            GLES20.glVertexAttribPointer(linePos,3,GLES20.GL_FLOAT,false,0,neural)
            GLES20.glUniform4f(lineColor,.20f,.92f,1f,.60f)
            GLES20.glDrawArrays(GLES20.GL_LINES,0,neuralCount)

            GLES20.glUseProgram(meshProgram)
            GLES20.glUniformMatrix4fv(meshMvp,1,false,out,0)
            GLES20.glUniform1f(meshLight,1f)
            GLES20.glUniform4f(meshColor,.035f,.63f,.86f,.62f)
            GLES20.glEnableVertexAttribArray(meshPos)
            GLES20.glVertexAttribPointer(meshPos,3,GLES20.GL_FLOAT,false,0,brain)
            GLES20.glDrawArrays(GLES20.GL_TRIANGLES,0,brainCount)

            GLES20.glUniform4f(meshColor,.035f,.70f,.92f,.52f)
            GLES20.glVertexAttribPointer(meshPos,3,GLES20.GL_FLOAT,false,0,cerebellum)
            GLES20.glDrawArrays(GLES20.GL_TRIANGLES,0,cerebellumCount)

            GLES20.glUseProgram(lineProgram)
            GLES20.glUniformMatrix4fv(lineMvp,1,false,out,0)
            GLES20.glEnableVertexAttribArray(linePos)
            GLES20.glVertexAttribPointer(linePos,3,GLES20.GL_FLOAT,false,0,grooves)
            GLES20.glUniform4f(lineColor,.16f,.86f,1f,.42f)
            GLES20.glLineWidth(1.35f)
            GLES20.glDrawArrays(GLES20.GL_LINES,0,groovesCount)

            GLES20.glUseProgram(pointProgram)
            GLES20.glUniformMatrix4fv(pointMvp,1,false,out,0)
            GLES20.glVertexAttribPointer(pointPos,3,GLES20.GL_FLOAT,false,0,gyri)
            GLES20.glUniform4f(pointColor,.25f,.95f,1f,.50f)
            GLES20.glUniform1f(pointSize,2.0f)
            GLES20.glDrawArrays(GLES20.GL_POINTS,0,gyriCount)

            spin+=.060f
        }
    }
}
