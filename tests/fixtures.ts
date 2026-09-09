export const outline = {
  elements: [{ id: 'course-1', name: 'Test Course', moduleIds: ['m2', 'm1'] }],
  linked: {
    'onDemandCourseMaterialModules.v1': [
      { id: 'm1', name: 'Second', lessonIds: ['l1'] },
      { id: 'm2', name: 'First', lessonIds: ['l2'] },
    ],
    'onDemandCourseMaterialLessons.v1': [
      { id: 'l1', name: 'Reading', itemIds: ['r1'] },
      { id: 'l2', name: 'Video', itemIds: ['v1', 'locked', 'quiz'] },
    ],
    'onDemandCourseMaterialItems.v2': [
      {
        id: 'r1',
        name: 'Read this',
        contentSummary: { typeName: 'supplement' },
      },
      { id: 'v1', name: 'Welcome', contentSummary: { typeName: 'lecture' } },
      {
        id: 'locked',
        name: 'Locked',
        isLocked: true,
        contentSummary: { typeName: 'lecture' },
      },
      { id: 'quiz', name: 'Quiz', contentSummary: { typeName: 'exam' } },
    ],
  },
};
export const lecture = {
  elements: [{ id: 'course-1~v1' }],
  linked: {
    'onDemandVideos.v1': [
      {
        id: 'video',
        subtitlesVtt: {
          en: '/api/subtitleAssetProxy.v1/example?fileExtension=vtt',
        },
        subtitles: {
          en: '/api/subtitleAssetProxy.v1/example?fileExtension=srt',
        },
      },
    ],
  },
};
export const reading = {
  elements: [{ id: 'course-1~r1' }],
  linked: {
    'openCourseAssets.v1': [
      {
        id: 'asset1',
        typeName: 'html',
        definition: {
          html: '<h1>Read me</h1><p>Hello <strong>reader</strong>.</p><pre>const x = 1;</pre>',
        },
      },
    ],
  },
};
export const vtt =
  'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nWelcome to the course.\n\n00:00:03.000 --> 00:00:05.000\nLearn Node.js.\n';
