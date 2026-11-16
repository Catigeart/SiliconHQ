#include "warp_trsm/solve.hpp"
#include <cuda_runtime.h>
#include <cuda_profiler_api.h>
#include <cublas_v2.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <vector>
#include <limits>
namespace w=warp_trsm;
const std::vector<int> rhs_sizes={1,2,4,8,16,32,64,128,256,512,1024,2048,4096};
void check(cudaError_t e){if(e!=cudaSuccess)throw std::runtime_error(cudaGetErrorString(e));}
void require(bool v,const char* msg){if(!v)throw std::runtime_error(msg);}
void blas_check(cublasStatus_t s){require(s==CUBLAS_STATUS_SUCCESS,"cuBLAS failure");}
struct Matrix {
    float* p{};size_t pitch{};int rows,cols,ld;
    Matrix(int r,int c,bool pad=false):rows(r),cols(c){
        check(cudaMallocPitch(&p,&pitch,size_t(r+(pad?3:0))*sizeof(float),c+1));ld=pitch/sizeof(float);
    }
    ~Matrix(){cudaFree(p);}
    Matrix(const Matrix&)=delete;
    std::vector<float> host()const{std::vector<float> v(size_t(ld)*(cols+1));check(cudaMemcpy(v.data(),p,v.size()*sizeof(float),cudaMemcpyDeviceToHost));return v;}
};
__host__ __device__ double exact_x(int row,int rhs){return 0.5+double((row*13+rhs*7)%31)/31.;}
__device__ double a_value(int r,int c,int n,int family,w::Uplo u,w::Diag d){
    if(r==c && d==w::Diag::unit)return 1;
    if(u==w::Uplo::lower?r<c:r>c)return 0;
    const double scale=family==1?ldexp(1.,r%17-8):1.;
    if(r==c)return scale*1.25;
    const double random=(double((r*17+c*31)%29)-14)/14;
    return float(scale*(family==2?-0.35/n:random*0.1/n));
}
__global__ void initialize_a(float* a,int ld,int n,int family,w::Uplo u,w::Diag d){
    for(size_t q=size_t(blockIdx.x)*blockDim.x+threadIdx.x;q<size_t(ld)*(n+1);q+=size_t(gridDim.x)*blockDim.x){
        int r=q%ld,c=q/ld;float v=8765;
        if(r<n&&c<n)v=(r==c&&d==w::Diag::unit)||(u==w::Uplo::lower?r<c:r>c)?nanf(""):a_value(r,c,n,family,u,d);
        a[q]=v;
    }
}
__device__ double effective_a(const float* a,int ld,int row,int col,w::Uplo u,w::Diag d,bool transpose){
    int r=transpose?col:row,c=transpose?row:col;
    if(r==c&&d==w::Diag::unit)return 1;
    if(u==w::Uplo::lower?r<c:r>c)return 0;
    return a[r+size_t(c)*ld];
}
__global__ void initialize_b(const float* a,int lda,float* b,int ldb,int n,int rhs,
                              w::Side side,w::Uplo u,w::Transpose t,w::Diag d){
    bool right=side==w::Side::right,transpose=(t==w::Transpose::transpose)!=right;
    int rows=right?rhs:n,cols=right?n:rhs;
    for(size_t q=size_t(blockIdx.x)*blockDim.x+threadIdx.x;q<size_t(ldb)*(cols+1);q+=size_t(gridDim.x)*blockDim.x){
        int r=q%ldb,c=q/ldb;float v=7654;
        if(r<rows&&c<cols){int row=right?c:r,col=right?r:c;double sum=0;
            for(int k=0;k<n;k++)sum+=effective_a(a,lda,row,k,u,d,transpose)*exact_x(k,col);
            v=float(sum);
        }
        b[q]=v;
    }
}
__global__ void residual(const float* a,int lda,const float* b0,int ldb0,const float* x,int ldx,
                         int n,int rhs,w::Side side,w::Uplo u,w::Transpose t,w::Diag d,float alpha,float* error){
    bool right=side==w::Side::right,transpose=(t==w::Transpose::transpose)!=right;
    for(size_t q=size_t(blockIdx.x)*blockDim.x+threadIdx.x;q<size_t(n)*rhs;q+=size_t(gridDim.x)*blockDim.x){
        int row=q%n,col=q/n;double sum=0,den=0;
        for(int k=0;k<n;k++){
            double av=effective_a(a,lda,row,k,u,d,transpose),xv=x[right?col+size_t(k)*ldx:k+size_t(col)*ldx];
            sum+=av*xv;den+=fabs(av)*fabs(xv);
        }
        double bv=alpha*b0[right?col+size_t(row)*ldb0:row+size_t(col)*ldb0];
        double value=fabs(sum-bv)/(den+fabs(bv)+1e-300);
        if(!isfinite(value))value=INFINITY;
        atomicMax(reinterpret_cast<unsigned*>(error),__float_as_uint(float(value)));
    }
}
struct Problem {
    int n,rhs;w::Side side;w::Uplo u;w::Transpose t;w::Diag d;
    Matrix a,b;
    Problem(int n_,int rhs_,int family=0,w::Side s=w::Side::left,w::Uplo u_=w::Uplo::lower,
            w::Transpose t_=w::Transpose::none,w::Diag d_=w::Diag::non_unit,bool pad=true)
      :n(n_),rhs(rhs_),side(s),u(u_),t(t_),d(d_),a(n,n,pad),b(s==w::Side::left?n:rhs,s==w::Side::left?rhs:n,pad){
        initialize_a<<<128,256>>>(a.p,a.ld,n,family,u,d);
        initialize_b<<<128,256>>>(a.p,a.ld,b.p,b.ld,n,rhs,side,u,t,d);check(cudaGetLastError());check(cudaDeviceSynchronize());
    }
    void launch(float* x,int ld,float alpha=1,cudaStream_t stream=nullptr){check(w::solve(side,u,t,d,n,rhs,alpha,a.p,a.ld,x,ld,stream));}
};
void run_case(int n,int rhs,int family=0,w::Side side=w::Side::left,w::Uplo u=w::Uplo::lower,
              w::Transpose t=w::Transpose::none,w::Diag d=w::Diag::non_unit,float alpha=1,bool instrument=false){
    Problem p(n,rhs,family,side,u,t,d);auto before_a=p.a.host(),before_b=p.b.host();
    Matrix x(p.b.rows,p.b.cols,true);
    require(x.ld==p.b.ld,"test pitch mismatch");
    check(cudaMemcpy(x.p,p.b.p,size_t(x.ld)*(x.cols+1)*sizeof(float),cudaMemcpyDeviceToDevice));
    cudaStream_t stream;check(cudaStreamCreateWithFlags(&stream,cudaStreamNonBlocking));
    p.launch(x.p,x.ld,alpha,stream);check(cudaStreamSynchronize(stream));check(cudaStreamDestroy(stream));
    auto got=x.host();bool right=side==w::Side::right;
    for(int c=0;c<=x.cols;c++)for(int r=0;r<x.ld;r++){
        auto value=got[r+size_t(c)*x.ld];
        if(c==x.cols||r>=x.rows)require(value==7654,"B padding/guard modified");
        else {require(std::isfinite(value),"nonfinite solve output");
            double expected=alpha*exact_x(right?c:r,right?r:c);
            require(std::abs(value-expected)<=1e-5*std::max(1.,std::abs(expected)),"manufactured solution error");}
    }
    auto after_a=p.a.host();require(std::memcmp(before_a.data(),after_a.data(),before_a.size()*sizeof(float))==0,"A modified");
    if(!instrument){
        // Independent CPU long-double substitution of the ACTUAL rounded RHS,
        // for first/middle/last RHS. All RHS additionally get GPU residual checks.
        bool transpose=(t==w::Transpose::transpose)!=right,forward=(u==w::Uplo::lower)!=transpose;
        auto av=[&](int row,int col)->long double{int r=transpose?col:row,c=transpose?row:col;
            if(r==c&&d==w::Diag::unit)return 1;return before_a[r+size_t(c)*p.a.ld];};
        for(int col:{0,rhs/2,rhs-1}){
            std::vector<long double> ref(n);
            for(int step=0;step<n;step++){
                int row=forward?step:n-1-step;
                long double value=alpha*static_cast<long double>(before_b[right?col+size_t(row)*p.b.ld:row+size_t(col)*p.b.ld]);
                for(int prev=0;prev<step;prev++){int k=forward?prev:n-1-prev;value-=av(row,k)*ref[k];}
                ref[row]=d==w::Diag::unit?value:value/av(row,row);
                require(std::abs(static_cast<long double>(got[right?col+size_t(row)*x.ld:row+size_t(col)*x.ld])-ref[row])<=1e-5L*std::max(1.L,std::abs(ref[row])),"CPU reference mismatch");
            }
        }
        float* err;check(cudaMalloc(&err,sizeof(float)));check(cudaMemset(err,0,sizeof(float)));
        residual<<<128,256>>>(p.a.p,p.a.ld,p.b.p,p.b.ld,x.p,x.ld,n,rhs,side,u,t,d,alpha,err);
        float value;check(cudaMemcpy(&value,err,sizeof(float),cudaMemcpyDeviceToHost));check(cudaFree(err));
        require(std::isfinite(value)&&value<=1e-5f,"normalized componentwise residual exceeds 1e-5");
    }
}
void compatibility(){
    for(int side=0;side<2;side++)for(int u=0;u<2;u++)for(int t=0;t<2;t++)for(int d=0;d<2;d++){
        run_case(33,3,0,w::Side(side),w::Uplo(u),w::Transpose(t),w::Diag(d),-.75f);
        std::cout<<"COMPAT,"<<side<<','<<u<<','<<t<<','<<d<<",PASS\n";
    }
    for(int n:{31,33,65})for(int rhs:{3,17,33}){run_case(n,rhs);std::cout<<"TAIL,"<<n<<','<<rhs<<",PASS\n";}
    run_case(33,17,0,w::Side::left,w::Uplo::lower,w::Transpose::none,w::Diag::non_unit,1.25f);
    std::cout<<"ALPHA,1.25,PASS\n";
    Matrix b(33,3,true);check(cudaMemset(b.p,0xff,b.pitch*4));
    check(w::solve(w::Side::left,w::Uplo::lower,w::Transpose::none,w::Diag::non_unit,33,3,0,nullptr,33,b.p,b.ld));
    auto result=b.host();for(int c=0;c<3;c++)for(int r=0;r<33;r++)require(result[r+size_t(c)*b.ld]==0,"alpha zero read A/B");
    require(w::solve(w::Side::left,w::Uplo::lower,w::Transpose::none,w::Diag::non_unit,33,3,1,nullptr,33,b.p,b.ld)==cudaErrorInvalidValue,"null A accepted");
    require(w::solve(w::Side::left,w::Uplo::lower,w::Transpose::none,w::Diag::non_unit,33,3,1,b.p,32,b.p,b.ld)==cudaErrorInvalidValue,"bad lda accepted");
    std::cout<<"ALPHA,0,PASS\n";
}
void benchmark(int n,int rhs,int iterations,int groups,bool profile,bool library){
    Problem p(n,rhs,0,w::Side::left,w::Uplo::lower,w::Transpose::none,w::Diag::non_unit,false);
    std::vector<float*> pool(iterations);
    for(auto& x:pool)check(cudaMalloc(&x,p.b.pitch*(p.b.cols+1)));
    cublasHandle_t h;blas_check(cublasCreate(&h));blas_check(cublasSetMathMode(h,CUBLAS_PEDANTIC_MATH));const float alpha=1;
    auto launch=[&](float* x){if(library)blas_check(cublasStrsm(h,CUBLAS_SIDE_LEFT,CUBLAS_FILL_MODE_LOWER,CUBLAS_OP_N,CUBLAS_DIAG_NON_UNIT,n,rhs,&alpha,p.a.p,p.a.ld,x,p.b.ld));else p.launch(x,p.b.ld);};
    auto reset=[&]{for(auto x:pool)check(cudaMemcpy(x,p.b.p,p.b.pitch*(p.b.cols+1),cudaMemcpyDeviceToDevice));check(cudaDeviceSynchronize());};
    for(int i=0;i<3;i++){reset();launch(pool[0]);check(cudaDeviceSynchronize());}
    cudaEvent_t start,end;check(cudaEventCreate(&start));check(cudaEventCreate(&end));
    for(int group=0;group<groups;group++){
        reset(); // Outside timed range; every invocation has a fresh B0.
        if(profile)check(cudaProfilerStart());else check(cudaEventRecord(start));
        for(auto x:pool)launch(x);
        if(profile){check(cudaDeviceSynchronize());check(cudaProfilerStop());std::cout<<"PROFILE,"<<n<<','<<rhs<<','<<group<<','<<iterations<<'\n';}
        else {check(cudaEventRecord(end));check(cudaEventSynchronize(end));float ms;check(cudaEventElapsedTime(&ms,start,end));std::cout<<"BENCH,"<<n<<','<<rhs<<','<<group<<','<<ms*1000/iterations<<'\n';}
    }
    cudaEventDestroy(start);cudaEventDestroy(end);cublasDestroy(h);for(auto x:pool)cudaFree(x);
}
int main(int argc,char**argv){try{
    require(argc>=3,"core|compat|sanitize|bench-ncu|bench-library-ncu|bench-events n [nrhs iterations groups]");
    std::string mode=argv[1];int n=std::stoi(argv[2]);require(n>=1&&n<=1024,"n outside first-phase contract");
    if(mode=="core"){
        for(int rhs:rhs_sizes){run_case(n,rhs);std::cout<<"CHECK,"<<n<<','<<rhs<<",0,PASS\n";}
        for(int family:{1,2}){run_case(n,17,family);std::cout<<"CHECK,"<<n<<",17,"<<family<<",PASS\n";}
    }else if(mode=="compat")compatibility();
    else if(mode=="sanitize"){
        std::vector<int> values={1,3,33};if(n==32)values.push_back(4096);
        for(int rhs:values){run_case(n,rhs,0,w::Side::left,w::Uplo::lower,w::Transpose::none,w::Diag::non_unit,1,true);std::cout<<"SANITIZE,"<<n<<','<<rhs<<",DONE\n";}
        run_case(n-1,17,0,w::Side::right,w::Uplo::upper,w::Transpose::transpose,w::Diag::unit,-.75f,true);
        std::cout<<"SANITIZE,"<<n-1<<",17,DONE\n";
    }else if(mode=="bench-ncu"||mode=="bench-library-ncu"||mode=="bench-events"){
        require(argc==6,"benchmark requires nrhs iterations groups");int rhs=std::stoi(argv[3]),iterations=std::stoi(argv[4]),groups=std::stoi(argv[5]);
        require(rhs>0&&rhs<=4096&&iterations>0&&iterations<=20&&groups>0&&groups<=3,"invalid sampling");
        benchmark(n,rhs,iterations,groups,mode!="bench-events",mode=="bench-library-ncu");
    }else throw std::invalid_argument("unknown mode");
    return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
