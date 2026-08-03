/** The tool definitions themselves: schema, description, annotations.
 *
 *  Names, parameter names and wording are lifted from `src/viberoom/
 *  mcp_server.py` on purpose — an agent that already knows the Python MCP
 *  server should find the same vocabulary here and not have to relearn it.
 *
 *  This is the subset that works in the browser with no backend. Deliberately
 *  absent, because they need the server and a tool that always fails is worse
 *  than a tool that is not offered: export, batch export, retouch, faces,
 *  tether, enhance, merge, auto-adjust, soft proof, LUT install, presets,
 *  collections, stacks, duplicates, history/snapshots/variants, IPTC/XMP.
 */

import * as h from './handlers'

/** Filter arguments shared by list_images, matching the REST query keys. */
const filterProps: Record<string, unknown> = {
  rating_gte: { type: 'integer', minimum: 0, maximum: 5, description: 'Only images rated >= this (0-5)' },
  flag: { type: ['string', 'null'], enum: ['pick', 'reject', 'none', null], description: "'pick', 'reject', or 'none' for unflagged" },
  keyword: { type: 'string', description: 'Exact keyword, case-insensitive' },
  camera: { type: 'string', description: 'Substring match on camera model' },
  lens: { type: 'string', description: 'Substring match on lens' },
  iso_gte: { type: 'integer', description: 'Minimum ISO' },
  iso_lte: { type: 'integer', description: 'Maximum ISO' },
  taken_after: { type: 'string', description: "'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' against EXIF capture time" },
  taken_before: { type: 'string', description: "'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' against EXIF capture time" },
  q: { type: 'string', description: 'Substring match on filename' },
  folder: { type: 'string', description: 'Relative-path prefix' },
  ext: { type: 'string', description: 'File extension, e.g. "cr2"' },
  has_edits: { type: 'boolean', description: 'Only images with (or without) an edit recipe' },
  sort: { type: 'string', enum: ['filename', 'mtime', 'rating', 'taken_at'], default: 'filename' },
  order: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
  limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
  offset: { type: 'integer', minimum: 0, default: 0 },
}

const imageId = { type: 'string', description: 'Image id, as returned by list_images' }

/** Ask a person first. `client` is optional in the draft and may be missing in
 *  an early implementation, so this degrades to "just do it" rather than
 *  refusing — the alternative is a tool that is unusable wherever the browser
 *  has not wired confirmation up yet. */
async function confirmed(client: WebMcpClient | undefined): Promise<void> {
  await client?.requestUserInteraction()
}

export const tools: WebMcpTool[] = [
  {
    name: 'list_images',
    description:
      'List images in the open library with optional filters. Returns each ' +
      "image's id, which all other tools take.",
    inputSchema: { type: 'object', properties: filterProps },
    annotations: { readOnlyHint: true },
    execute: (input) => h.listImages(input),
  },
  {
    name: 'get_image',
    description: 'Full metadata for one image: path, EXIF, rating, flag, edit status.',
    inputSchema: {
      type: 'object',
      properties: { image_id: imageId },
      required: ['image_id'],
    },
    annotations: { readOnlyHint: true },
    execute: (input) => h.getImage(input),
  },
  {
    name: 'get_current_image',
    description:
      'The image the user currently has selected/open in Viberoom (or ' +
      "image_id: null if nothing is selected). Use this when the user says " +
      "'this image' / 'my current image'.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: () => h.getCurrentImage(),
  },
  {
    name: 'set_rating',
    description: 'Set the star rating, 0 (unrated) to 5.',
    inputSchema: {
      type: 'object',
      properties: {
        image_id: imageId,
        rating: { type: 'integer', minimum: 0, maximum: 5, description: 'Stars, 0-5' },
      },
      required: ['image_id', 'rating'],
    },
    execute: (input) => h.setRating(input),
  },
  {
    name: 'set_flag',
    description: "Flag an image as 'pick' or 'reject', or null to unflag.",
    inputSchema: {
      type: 'object',
      properties: {
        image_id: imageId,
        flag: { type: ['string', 'null'], enum: ['pick', 'reject', null] },
      },
      required: ['image_id', 'flag'],
    },
    execute: (input) => h.setFlag(input),
  },
  {
    name: 'get_recipe',
    description: "Get the image's current non-destructive edit recipe (JSON).",
    inputSchema: {
      type: 'object',
      properties: { image_id: imageId },
      required: ['image_id'],
    },
    annotations: { readOnlyHint: true },
    execute: (input) => h.getRecipe(input),
  },
  {
    name: 'update_recipe',
    description:
      "Merge a partial recipe into the image's edit recipe (the usual way to " +
      'edit). Only supply the fields you want to change; everything else keeps ' +
      'its value. Lists (toneCurve points, masks) replace wholesale, so send ' +
      'the full masks array when editing masks. Ranges (Lightroom-style):\n' +
      '- whiteBalance: {temp: 2000-50000 Kelvin (null=as-shot), tint: -150..150 (+magenta)}\n' +
      '- tone: {exposure: -5..5 EV, contrast/highlights/shadows/whites/blacks: -100..100,\n' +
      '         texture/clarity/dehaze: -100..100,\n' +
      '         toneCurve: {points: [[in,out],...] 0-255 increasing; red/green/blue: same}}\n' +
      '- color: {saturation/vibrance: -100..100,\n' +
      '          hsl: {red|orange|yellow|green|aqua|blue|purple|magenta:\n' +
      '                {hue/saturation/luminance: -100..100}},\n' +
      '          grading: {shadows|midtones|highlights: {hue: 0-360, saturation: 0-100,\n' +
      '                     luminance: -100..100}, blending: 0-100, balance: -100..100}}\n' +
      '- detail: {sharpening: {amount: 0-150, radius: 0.5-3, detail: 0-100},\n' +
      '           noiseReduction: {luminance: 0-100, color: 0-100}}\n' +
      '- geometry: {rotate: -45..45 deg, orientation: 0|90|180|270, flipH/flipV: bool,\n' +
      '             perspective: {vertical/horizontal: -100..100, scale: 50-150},\n' +
      '             crop: {left,top,right,bottom: 0-1 normalized}}\n' +
      '- lens: {distortion: -100..100, vignette: -100..100, caRed/caBlue: -100..100,\n' +
      '         defringe: {amount: 0-100}} — applied first, pre-crop\n' +
      '- effects: {vignette: {amount: -100..100 (negative darkens), midpoint/feather: 0-100,\n' +
      '            roundness: -100..100}, grain: {amount: 0-100, size: 0-100}}\n' +
      '- masks: local adjustments; a list of {type, ...geometry, invert, opacity: 0-100,\n' +
      '         adjustments: {exposure: -5..5, contrast/highlights/shadows/temp/tint/\n' +
      '         saturation/clarity/dehaze/sharpness: -100..100}}. Coordinates are\n' +
      '         normalized 0-1 in the RENDERED (post-crop) frame. Types:\n' +
      "         {type: 'linear', start: [x,y], end: [x,y]}\n" +
      "         {type: 'radial', center: [x,y], radiusX/radiusY: 0-2, feather: 0-100}\n" +
      "         {type: 'luminance', lumMin/lumMax: 0-100, feather: 0-100}\n" +
      "         {type: 'color', hue: 0-360, range: 5-180}\n" +
      "         {type: 'brush', strokes: [{points: [[x,y],...], radius: 0-0.5,\n" +
      '          feather/flow: 0-100, erase: bool}]}\n' +
      'Not every field renders in the browser yet — render_preview reports which ' +
      'engine drew the pixels it returns.',
    inputSchema: {
      type: 'object',
      properties: {
        image_id: imageId,
        patch: {
          type: 'object',
          description: 'Partial recipe to merge; see the tool description for ranges',
        },
      },
      required: ['image_id', 'patch'],
    },
    execute: (input) => h.updateRecipe(input),
  },
  {
    name: 'set_recipe',
    description:
      'Replace the entire edit recipe. Omitted fields reset to defaults, so ' +
      'this discards any edit not present in `recipe` — prefer update_recipe ' +
      'unless you mean to start over. Asks the user to confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        image_id: imageId,
        recipe: { type: 'object', description: 'The complete replacement recipe' },
      },
      required: ['image_id', 'recipe'],
    },
    // Wholesale replacement silently drops work the agent never saw: the user
    // may have edits in sections the agent is not thinking about.
    annotations: { destructiveHint: true },
    execute: async (input, client) => {
      await confirmed(client)
      return h.setRecipe(input)
    },
  },
  {
    name: 'reset_recipe',
    description:
      'Remove all edits, restoring the image to its unedited state. Asks the ' +
      'user to confirm.',
    inputSchema: {
      type: 'object',
      properties: { image_id: imageId },
      required: ['image_id'],
    },
    // There is no server-side history in the PWA to undo this from.
    annotations: { destructiveHint: true },
    execute: async (input, client) => {
      await confirmed(client)
      return h.resetRecipe(input)
    },
  },
  {
    name: 'render_preview',
    description:
      'Render the image WITH its current edits applied and return the JPEG ' +
      '(base64) so you can visually inspect the result. size = longest edge in ' +
      "px (256-4096). `rendered` says which engine drew it: 'server' (full " +
      "recipe), 'gpu' (what the browser shader supports), or 'original' (the " +
      'untouched file, when nothing could be applied).',
    inputSchema: {
      type: 'object',
      properties: {
        image_id: imageId,
        size: { type: 'integer', minimum: 256, maximum: 4096, default: 1024 },
      },
      required: ['image_id'],
    },
    annotations: { readOnlyHint: true },
    execute: (input) => h.renderPreview(input),
  },
]
