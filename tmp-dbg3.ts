import { Pool } from 'pg'
import { prisma } from './lib/db/prisma'
import { detectIndexBloat, MIN_REMEASURE_MINUTES } from './lib/autonomy/index-bloat'
;(async()=>{
  const user = await prisma.user.create({ data: { email:`dbg3-${Date.now()}@t.test`, password:'x', name:'d' } })
  const proj = await prisma.project.create({ data: { name:'dbg3', userId: user.id } })
  const S = `workspace_${proj.id}`
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const led = async (l:string) => {
    const r = await prisma.projectPreference.findMany({ where:{projectId:proj.id,type:'index_bloat_scan'}, select:{key:true,value:true} })
    console.log(l, r.map(x=>`${x.key}=${x.value}`).join(' | ') || '(empty)')
  }
  try {
    await pool.query(`CREATE SCHEMA "${S}"`)
    await pool.query(`CREATE TABLE "${S}"."events" (id serial primary key, k int, pad text)`)
    await pool.query(`INSERT INTO "${S}"."events"(k,pad) SELECT i, repeat('x',60) FROM generate_series(1,600000) i`)
    await pool.query(`CREATE INDEX idx_events_k ON "${S}"."events"(k)`)

    console.log('probe#1 (healthy):', (await detectIndexBloat(proj.id)).length)
    await led('  ledger#1:')

    await pool.query(`DELETE FROM "${S}"."events" WHERE k % 10 <> 0`)
    await pool.query(`VACUUM "${S}"."events"`)
    console.log('probe#2 (no backdate, expect 0 due to cooldown):', (await detectIndexBloat(proj.id)).length)

    const older = new Date(Date.now() - (MIN_REMEASURE_MINUTES+5)*60000).toISOString()
    for (const r of await prisma.projectPreference.findMany({ where:{projectId:proj.id,type:'index_bloat_scan'}, select:{key:true,value:true} })) {
      await prisma.projectPreference.update({ where:{ projectId_type_key:{projectId:proj.id,type:'index_bloat_scan',key:r.key} },
        data:{ value: JSON.stringify({ ...JSON.parse(r.value), measuredAt: older }) } })
    }
    await led('  ledger backdated:')
    const f = await detectIndexBloat(proj.id)
    console.log('probe#3 (backdated):', f.length, f.map(x=>(x.details as any).indexName).join(','))
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${S}" CASCADE`).catch(()=>{})
    await pool.end()
    await prisma.projectPreference.deleteMany({ where:{projectId:proj.id} }).catch(()=>{})
    await prisma.project.delete({ where:{id:proj.id} }).catch(()=>{})
    await prisma.user.delete({ where:{id:user.id} }).catch(()=>{})
  }
  process.exit(0)
})().catch(e=>{console.error(e); process.exit(1)})
