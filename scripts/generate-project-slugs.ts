/**
 * Generate slugs for existing projects that don't have them
 */

import { PrismaClient } from '@prisma/client';
import { generateSlug } from '../lib/utils/slug';

const prisma = new PrismaClient();

async function generateProjectSlugs() {
  console.log('🔍 Finding projects without slugs...');

  const projectsWithoutSlugs = await prisma.project.findMany({
    where: {
      slug: null,
    },
    select: {
      id: true,
      name: true,
    },
  });

  console.log(`\n📊 Found ${projectsWithoutSlugs.length} projects without slugs`);

  if (projectsWithoutSlugs.length === 0) {
    console.log('✅ All projects already have slugs!');
    return;
  }

  console.log('\n🔨 Generating slugs...\n');

  for (const project of projectsWithoutSlugs) {
    let slug = generateSlug(project.name);
    let counter = 1;

    // Check for conflicts and add counter if needed
    while (true) {
      const existing = await prisma.project.findUnique({
        where: { slug },
      });

      if (!existing) break;

      slug = `${generateSlug(project.name)}-${counter}`;
      counter++;
    }

    await prisma.project.update({
      where: { id: project.id },
      data: { slug },
    });

    console.log(`✅ ${project.name} → ${slug}`);
  }

  console.log(`\n✨ Successfully generated slugs for ${projectsWithoutSlugs.length} projects!`);
}

generateProjectSlugs()
  .then(() => {
    console.log('\n✅ Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Error:', error);
    process.exit(1);
  });
