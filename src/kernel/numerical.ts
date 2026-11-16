import { z } from 'zod';
export const numericalMarker = 'SIHQ_NUMERICAL_DIAGNOSTICS_V1';
const replacements: [string, string][] = [
  [
    '    cudaStream_t stream;check(cudaStreamCreateWithFlags(&stream,cudaStreamNonBlocking));',
    '    // D2D cudaMemcpy may return before completion; a nonblocking stream does not wait for it.\n    check(cudaDeviceSynchronize());\n    cudaStream_t stream;check(cudaStreamCreateWithFlags(&stream,cudaStreamNonBlocking));',
  ],
  [
    'void check(cudaError_t e){if(e!=cudaSuccess)throw std::runtime_error(cudaGetErrorString(e));}',
    '\n// SIHQ_NUMERICAL_DIAGNOSTICS_V1: diagnostics and input-copy synchronization; predicates and inputs unchanged.\n#include <iomanip>\n#include <sstream>\nstruct NumericalContext {\n    int n=0,nrhs=0,family=0,side=0,uplo=0,trans=0,diag=0,lda=0,ldb=0,ldx=0;\n    float alpha=1;\n    int launchStatus=0,syncStatus=0;\n};\nstatic NumericalContext numerical_context;\nstd::string diagnostic_number(long double value) {\n    if (!std::isfinite(value)) return "null";\n    std::ostringstream out; out << std::setprecision(21) << value; return out.str();\n}\nvoid numerical_require(bool passed,const char* kind,int row,int rhs,\n                       long double actual,long double expected,long double tolerance) {\n    if (passed) return;\n    const auto& c=numerical_context;\n    std::cerr << "NUMERICAL_FAILURE,{\\"schemaVersion\\":1,\\"kind\\":" << std::quoted(kind)\n      << ",\\"n\\":" << c.n << ",\\"nrhs\\":" << c.nrhs << ",\\"family\\":" << c.family\n      << ",\\"side\\":" << c.side << ",\\"uplo\\":" << c.uplo << ",\\"trans\\":" << c.trans << ",\\"diag\\":" << c.diag\n      << ",\\"alpha\\":" << diagnostic_number(c.alpha)\n      << ",\\"row\\":" << row << ",\\"rhsIndex\\":" << rhs\n      << ",\\"actual\\":" << diagnostic_number(actual) << ",\\"expected\\":" << diagnostic_number(expected)\n      << ",\\"actualText\\":" << std::quoted(diagnostic_number(actual)=="null"?std::to_string(double(actual)):diagnostic_number(actual))\n      << ",\\"absoluteError\\":" << diagnostic_number(std::abs(actual-expected))\n      << ",\\"tolerance\\":" << diagnostic_number(tolerance)\n      << ",\\"lda\\":" << c.lda << ",\\"ldb\\":" << c.ldb << ",\\"ldx\\":" << c.ldx\n      << ",\\"launchStatus\\":" << c.launchStatus << ",\\"syncStatus\\":" << c.syncStatus\n      << ",\\"cudaLastError\\":" << int(cudaPeekAtLastError()) << "}\\n";\n    throw std::runtime_error(kind);\n}\n\nvoid check(cudaError_t e){if(e!=cudaSuccess){numerical_require(false,cudaGetErrorString(e),-1,-1,int(e),0,0);}}',
  ],
  [
    '    Problem p(n,rhs,family,side,u,t,d);auto before_a=p.a.host(),before_b=p.b.host();',
    '    numerical_context={n,rhs,family,int(side),int(u),int(t),int(d),0,0,0,alpha,0,0};\n    Problem p(n,rhs,family,side,u,t,d);auto before_a=p.a.host(),before_b=p.b.host();\n    numerical_context.lda=p.a.ld;numerical_context.ldb=p.b.ld;',
  ],
  [
    '    require(x.ld==p.b.ld,"test pitch mismatch");',
    '    numerical_context.ldx=x.ld;\n    require(x.ld==p.b.ld,"test pitch mismatch");',
  ],
  [
    '    p.launch(x.p,x.ld,alpha,stream);check(cudaStreamSynchronize(stream));check(cudaStreamDestroy(stream));',
    '    numerical_context.launchStatus=int(w::solve(side,u,t,d,n,rhs,alpha,p.a.p,p.a.ld,x.p,x.ld,stream));\n    check(cudaError_t(numerical_context.launchStatus));\n    numerical_context.syncStatus=int(cudaStreamSynchronize(stream));\n    check(cudaError_t(numerical_context.syncStatus));check(cudaStreamDestroy(stream));',
  ],
  [
    'require(value==7654,"B padding/guard modified");',
    'numerical_require(value==7654,"B padding/guard modified",r,c,value,7654,0);',
  ],
  [
    'require(std::isfinite(value),"nonfinite solve output");',
    'numerical_require(std::isfinite(value),"nonfinite solve output",right?c:r,right?r:c,value,0,0);',
  ],
  [
    'require(std::abs(value-expected)<=1e-5*std::max(1.,std::abs(expected)),"manufactured solution error");',
    'numerical_require(std::abs(value-expected)<=1e-5*std::max(1.,std::abs(expected)),"manufactured solution error",right?c:r,right?r:c,value,expected,1e-5*std::max(1.,std::abs(expected)));',
  ],
  [
    'require(std::memcmp(before_a.data(),after_a.data(),before_a.size()*sizeof(float))==0,"A modified");',
    'numerical_require(std::memcmp(before_a.data(),after_a.data(),before_a.size()*sizeof(float))==0,"A modified",-1,-1,1,0,0);',
  ],
  [
    'require(std::abs(static_cast<long double>(got[right?col+size_t(row)*x.ld:row+size_t(col)*x.ld])-ref[row])<=1e-5L*std::max(1.L,std::abs(ref[row])),"CPU reference mismatch");',
    'numerical_require(std::abs(static_cast<long double>(got[right?col+size_t(row)*x.ld:row+size_t(col)*x.ld])-ref[row])<=1e-5L*std::max(1.L,std::abs(ref[row])),"CPU reference mismatch",row,col,got[right?col+size_t(row)*x.ld:row+size_t(col)*x.ld],ref[row],1e-5L*std::max(1.L,std::abs(ref[row])));',
  ],
  [
    'require(std::isfinite(value)&&value<=1e-5f,"normalized componentwise residual exceeds 1e-5");',
    'numerical_require(std::isfinite(value)&&value<=1e-5f,"normalized componentwise residual exceeds 1e-5",-1,-1,value,0,1e-5f);',
  ],
  [
    '    if(mode=="core"){',
    '    if(mode=="numerical"){\n        require(argc==4,"numerical n nrhs");int rhs=std::stoi(argv[3]);require(rhs>0&&rhs<=4096,"invalid rhs");\n        run_case(n,rhs);std::cout<<"NUMERICAL_PASS,"<<n<<\',\'<<rhs<<\'\\n\';\n    }else if(mode=="core"){',
  ],
];
export function instrumentSolverTests(source: string): string {
  if (source.includes(numericalMarker)) return source;
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2)
      throw new Error('无法识别冻结测试版本，拒绝自动修改数值契约：' + before.slice(0, 80));
    source = source.replace(before, after);
  }
  return source;
}
const scalar = z.number().finite().nullable();
export const numericalFailureSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.string(),
  n: z.number().int(),
  nrhs: z.number().int(),
  family: z.number().int(),
  side: z.number().int(),
  uplo: z.number().int(),
  trans: z.number().int(),
  diag: z.number().int(),
  alpha: scalar,
  row: z.number().int(),
  rhsIndex: z.number().int(),
  actual: scalar,
  expected: scalar,
  actualText: z.string(),
  absoluteError: scalar,
  tolerance: scalar,
  lda: z.number().int(),
  ldb: z.number().int(),
  ldx: z.number().int(),
  launchStatus: z.number().int(),
  syncStatus: z.number().int(),
  cudaLastError: z.number().int(),
});
export function numericalFailures(output: string) {
  return output
    .split(/\r?\n/)
    .filter((l) => l.startsWith('NUMERICAL_FAILURE,'))
    .map((l) => numericalFailureSchema.parse(JSON.parse(l.slice('NUMERICAL_FAILURE,'.length))));
}
