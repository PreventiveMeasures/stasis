// Logos for where an advisory comes from, as `stasis audit` may draw them beside it: sixel images, for a
// terminal that draws them, as supported() asks it.

// Each a sixel image 16 pixels square, prepared once (nothing here converts one): its pixels square (P1 9,
// and raster attributes 1:1), its background left as the terminal has it (P2 1), in 8 colours at most.
// Its edges inside are blended; its outline isn't, as nothing tells a sixel image what it's drawn over, so
// a pixel is drawn where at least half of it is covered.

// npm's registry (upstream's `registry` source): simple-icons' npm (16.36.0, CC0-1.0), #CB3837, its
// knocked-out n filled white.
export const NPM = '\x1bP9;1q"1;1;16;16#1;2;80;22;22#2;2;100;100;100#3;2;91;66;66#4;2;94;78;77#5;2;89;56;56#6;2;92;71;71#7;2;97;88;88#8;2;85;42;42' +
  '#1~~~!10F~~~$#2!4?!4oOOoo$#3???o$#5!4?!8G$#6!12?o$#7!8?__$#8???G!8?G-' +
  '#1~~~!5?~~???~~~$#2!4?!4~???~$#3???~$#4!10?~$#6!12?~-' +
  '#1NNN!5MNNMMMNNN$#3!10?@?@$#4!4?!4@$#5???@$#7!11?@' +
  '\x1b\\'

// A GitHub repository's advisories (`repository`): simple-icons' GitHub (16.36.0, CC0-1.0), #181717, its
// knocked-out Octocat filled white, so that the mark shows on a dark terminal too.
export const GITHUB = '\x1bP9;1q"1;1;16;16#1;2;9;9;9#2;2;100;100;100#3;2;15;15;15#4;2;90;90;90#5;2;45;45;45#6;2;26;26;26#7;2;80;80;80#8;2;57;57;57' +
  '#1_o{CEE!4NEEC{o_$#2!4?o!6_o$#3!5?G!4?G$#4!5?O?OO?O$#5???oG!6?Go$#6???G!8?G$#7!6?O??O-' +
  '#1^~X!9?_x~^$#2???E^^^~~^^^E$#3??E!10?E$#4???H??_??_$#5??_$#6???o_!6?_O$#7!12?H$#8!5?_!4?_-' +
  '#1?@AC!6?FFFB@$#2!4?AAMNNG$#3??@?CL!4?G$#4!6?@??F$#5???A$#6!4?@$#7???@' +
  '\x1b\\'

// OSV (`osv`): OSV's logo as @preventive/triage draws an advisory's source (viewBox 0 75 405 400), its
// ring, `currentColor` there, triage's muted grey (#8b949e).
export const OSV = '\x1bP9;1q"1;1;16;16#1;2;55;58;62#2;2;88;13;16#3;2;98;86;86#4;2;92;43;45#5;2;94;62;63#6;2;88;17;20#7;2;96;74;75#8;2;99;95;95' +
  '#1?o{{MM!4FEM[{o$#2!5?__OO__$#6!7?__-' +
  '#1N~~O!8?o~~N$#2!5?^PooP^E$#3!7?IK$#4!6?I??I$#5!6?C@@C$#7!8?A$#8!7?C-' +
  '#1???CEF!4MFFB@' +
  '\x1b\\'

// The three at each size, made as those above are (simple-icons' and triage's paths, at least half a
// pixel covered for a pixel to be drawn, in 8 colours at most): 16 pixels for the cells most terminals
// draw sixel images over, more for larger ones, as a Retina screen's are in iTerm2, two pixels a point.
const LOGOS = {
  16: { npm: NPM, github: GITHUB, osv: OSV },
  20: {
    npm: '\x1bP9;1q"1;1;20;20#1;2;80;22;22#2;2;100;100;100#3;2;89;58;58#4;2;80;22;21#5;2;95;79;79#6;2;80;24;24#7;' +
    '2;82;31;31#8;2;96;84;84#1|!3~!12N!4~$#2!5?!10_$#3!4?!12O$#4A$#5!4?_$#8!15?_-#1!4~!7?{!4?!4~$#2!5?!5~' +
    '!3@~~$#3!12?A$#5!4?~$#6!10?{$#7!10?AA{$#8!15?~-#1!4~!7o~!4o!4~$#2!5?!5N!3?NN$#5!4?N$#6!10?N$#7!12?N$' +
    '#8!15?N-#1?@!16B@@$#4@A!16?A\x1b\\',
    github: '\x1bP9;1q"1;1;20;20#1;2;18;18;18#2;2;100;100;100#3;2;9;9;9#4;2;33;33;33#5;2;52;52;52#6;2;74;73;73#2!5?_' +
    '_?!4_?__$#3?_owKMM]!4^]MMKwo_$#4!4?O?O!6?O?O$#5!4?_!10?_$#6!5?O?_!4?_?O-#1!3?c!12?c$#2!4?{!10~{$#3}~' +
    '~B!12?B~~}$#4!3?W!12?W$#5!4?@!10?@$#6!4?A!10?A-#1??C?EG!9?A$#2!5?PBR!4~BB@$#3@FZr_CG!6?w{{~^F@$#4!3?' +
    'G??CG!4?GC$#5!3?C?_?C!4?s$#6!4?XAo_!6?A@-#2!8?!4@$#3!4?@@B!6?B@$#4!12?@$#5!7?@\x1b\\',
    osv: '\x1bP9;1q"1;1;20;20#1;2;54;58;62#2;2;88;14;17#3;2;97;76;77#4;2;91;38;41#5;2;55;58;62#1?_OC?A?@H@!3H?Q??' +
    'W_$#2!9?!3_$#5??_w{[]MEM!3EMK{w_-#1C??{@!11?U??[$#2!6?}nF@@FN}G$#3!8?o{{w$#4!7?OGAA?o$#5w~~B!12?h~~_' +
    '-#1?EG?AOG!4?O?GCa?G$#2!6?@BBAABB@$#4!9?@@$#5?@FF__!5o_oow[^FF-#1!4?!3@??A?A?@@$#5!7?@B@B@@\x1b\\',
  },
  24: {
    npm: '\x1bP9;1q"1;1;24;24#1;2;80;22;22#2;2;100;100;100#3;2;93;73;73#4;2;84;40;40#5;2;79;22;22#6;2;99;96;96#7;' +
    '2;98;91;91#8;2;99;97;97#1}!4~!14^!3~}{$#3!5?!14_$#5!22?@A-#1!5~!7?!3w!4?!5~$#2!6?!6~!4B~~$#3!12?!3Cw' +
    '$#7!5?~!9?C$#8!18?~-#1!5~!7?!3~!4?!5~$#2!6?!6~!4?~~$#3!15?~$#6!18?~$#7!5?~-#1^!4~!7{!3~!4{!3~^N$#2!6' +
    '?!6@!4?@@$#3!15?@$#4!5?!7A!3?!4A$#5!22?_O$#6!18?@$#7!5?@\x1b\\',
    github: '\x1bP9;1q"1;1;24;24#1;2;10;9;9#2;2;100;100;100#3;2;9;9;9#4;2;73;73;73#5;2;55;55;55#6;2;30;29;29#1??_ooW' +
    '[[!8}][Ww__$#3!4?GC?A??!4@!4?C?O$#4!6?_!10?_$#5!16?_$#6!5?_?_!10?_-#1G}~~N!14?N~~}$#2!5?w~~}}!4~}}~~' +
    'w$#3o@!21?w$#4!4?_B??@@!4?@@$#5!4?OC!12?Fo-#1@^~^Wo_!10?_o{~~^D$#2!5?FN!3^!4~!3^NF$#3M_!20?_A$#4!4?_' +
    '?O??_!4?_$#5!3?_BG??_!6?_?OGB$#6!4?C??_!8?_-#1!3?BEGHPX!6?^^NNFB@$#2!5?A!3CM!4^M$#3??@CG?O?_!6?_?O?G' +
    'C$#4!4?@@A??@!4?@$#5!7?AA$#6!5?C?G\x1b\\',
    osv: '\x1bP9;1q"1;1;24;24#1;2;98;87;88#2;2;88;13;16#3;2;89;24;27#4;2;54;58;62#5;2;55;58;62#6;2;93;50;52#4!4?G' +
    'C?a?!6@OaAC??_$#5??_oow}[]!7M[{wwo-#1!10?_gg_$#2!7?w{]ABFA]}w$#3!10?[C?[$#4o!3?O!13?AK??AO$#5?}~~NB@' +
    '!11?@B~~{g$#6!9?_?OO?_-#1!10?BFFB$#2!7?FN!6WNF$#4?W_?aO!11?_OC??OD$#5@F^~[!13?_w~~NA$#6!9?FC??CF-#4?' +
    '?@@GCA@?AA?__??@?GCA@$#5!5?GK]][{{[[!3]NFB@\x1b\\',
  },
  28: {
    npm: '\x1bP9;1q"1;1;28;28#1;2;80;22;22#2;2;100;100;100#3;2;95;80;80#4;2;85;41;41#5;2;80;25;25#6;2;80;25;24#7;' +
    '2;82;31;30#8;2;80;24;23#1}!26~}-#1!5~!10?!3_!5?!5~$#2!6?!8}!4M!4}$#3!6?!16@$#4!14?!4O$#5!14?_$#7!22?' +
    '~$#8!5?~-#1!5~!10?!3~!5?!5~$#2!6?!8~!4?!4~$#5!14?~$#6!5?{$#7!22?~$#8!5?B-#1!5~o!8_o!3~!5_!5~$#2!6?!8' +
    'N!4?!4N$#4!6?!8O!4?!4O$#5!5?K!8?@$#6!5?B!8?M$#7!22?N$#8!22?O-#1F!26NF\x1b\\',
    github: '\x1bP9;1q"1;1;28;28#1;2;43;43;43#2;2;100;100;100#3;2;9;9;9#4;2;20;20;20#5;2;9;8;8#6;2;67;66;66#7;2;82;8' +
    '1;81#3!3?_oww{!4}!4~!4}{wwo_$#5!11?@!4?@-#1!6?@!14?@_$#2!6?o~}}{{!4}{{}}~o$#3_{!3~N!4?!8@!4?N!3~{_$#' +
    '4!5?O!3?@!8?@!3?O$#6!5?_G?@?A!6?A?@?M$#7!6?E!4?A!4?A-#1!5?O!16?O$#2!5?A!16~$#3!5~!17?_!5~$#4!5?_$#6!' +
    '22?G$#7!5?L!16?F-#1!5?O@?OOC!6?s$#2!6?O``bbz!4~zBB@@$#3?BN~pbEKKG!8?!3{}~~^NB$#4!4?I??A?CG!6?G??A@$#' +
    '5?C!24?C$#6!6?gO??O!8?A$#7!4?CK??A??C!4?C-#1!7?@??A!6?B$#2!11?B!4FB$#3!4?@@BEEM!8?!3FB@@$#4!10?C!6?C' +
    '$#6!8?@@$#7!10?@\x1b\\',
    osv: '\x1bP9;1q"1;1;28;28#1;2;93;52;53#2;2;88;15;18#3;2;54;58;62#4;2;99;89;89#5;2;55;58;62#3!3?_oww{!3}!6^~}{' +
    '{woo_$#5!19?A?CG-#1!12?OO?O$#2!8?_w{{kM[k{{w_$#3?w}~~^FB@!10?@BB^!3~{_$#4!13?__$#5!21?C-#1!11?M?``@]' +
    'G$#2!8?^~~``??_`v~^$#3A!4~_!16?_!4~B$#4!11?O!4]$#5!5?O!21?K-#2!10?@!6B@@$#3?@BNFB?_!4o!5_ooww{~~^FA$' +
    '#5??C!17?CA!4?@-#3!5?A!3B!4F!3N!4FBB@$#5!12?G!3?G\x1b\\',
  },
  32: {
    npm: '\x1bP9;1q"1;1;32;32#1;2;80;22;22#2;2;100;100;100#3;2;91;65;65#4;2;81;26;26#5;2;85;44;43#6;2;83;34;34#7;' +
    '2;86;48;48#8;2;83;36;35#1}!30~}-#1!6~!20@!6~$#2!7?!9}!4]!5}$#3!16?!4_$#5!25?}$#6!6?]$#8!6?_-#1!6~!11' +
    '?!3~!6?!6~$#2!7?!9~!5?!4~$#4!16?~$#5!25?~$#7!20?~$#8!6?~-#1!6~!11?!3~!6?!6~$#2!7?!9~!5?!4~$#4!16?~$#' +
    '5!25?~$#7!20?~$#8!6?~-#1!6~!10{}!3~!6{!6~$#2!7?!9@!5?!4@$#3!7?!9A!5?!4A$#4!6?A!9?@$#5!25?@$#6!25?A$#' +
    '7!20?@$#8!6?@!13?A-#1@!30B@\x1b\\',
    github: '\x1bP9;1q"1;1;32;32#1;2;30;30;30#2;2;100;100;100#3;2;9;9;9#4;2;10;9;9#5;2;92;92;92#6;2;57;56;56#7;2;77;' +
    '77;77#3!4?_?OGC?AA!8?A??C?O$#4!5?__ow!3{!8}!3{ww__-#1!10?A?C!6?C?A$#2!8?}{{!10w{{}$#3?OCA!24?ACO$#4?' +
    '_w{!3~!4@!10B!4@!3~{w_$#5!7?G$#6!7?A!3?C?CC??CC?C!3?A$#7!7?s?A!5?CC!5?A?{-#1!5?[!19?@G$#2!6?{!18~{$#' +
    '3U!30?e$#4g!4~b!20?v!4~W$#5!6?A$#6!6?@$#7!25?A-#1!4?o!4?O?_!10?O??A$#2!7?BFNN^^!6~^^NNFB$#3AO!28?O$#' +
    '4@N~~N^[wo__!9?!3_ow{!4~NB$#5!5?_$#6!6?A!5?_!6?_$#7!6?`CG?O!10?O?GC@-#1!5?@CG?OOQ$#2!6?@EC!3K{!6~$#3' +
    '!5?O!18?_!3?A$#4??@BNMWopbb`!8?!4~^^NF@@$#5!8?G!3?A!6?{$#6!6?A@A!3?@!6?@$#7!19?A-#2!14?!4@$#3!8?@@$#' +
    '4!10?@@!8?!4@\x1b\\',
    osv: '\x1bP9;1q"1;1;32;32#1;2;99;92;92#2;2;92;42;44#3;2;88;13;16#4;2;95;64;66#5;2;54;58;62#5!4?_oww{{}}!8~}}{' +
    '{wwo_-#2!14?_??_$#3!10?_owwW{wWwwo_$#5?o{}!3~NFB@@!8?@@BFN!4~{o-#1!14?wyAwG$#2!12?W?B?@??W$#3!9?}~~F' +
    'F!4?FF~~}$#4!12?_wCD{Fo_$#5?!5~!20?!5~}-#1!13?@@BB@@$#2!12?B!6?B$#3!9?@FNK]!4[]KNF@$#4!14?A??A$#5?F!' +
    '4~]!16?_w{!4~N-#5!3?@@_ow{}~}!8{}}~~^NNF@-#5!10?!4@!5B!3@\x1b\\',
  },
  40: {
    npm: '\x1bP9;1q"1;1;40;40#1;2;80;22;22#2;2;100;100;100#3;2;83;35;35#4;2;95;81;81#5;2;92;69;69#6;2;89;58;58#7;' +
    '2;79;22;21#8;2;92;68;68#1w}}!34~}}{$#7E@@!34?@@A-#1!8~!15B!9F!8~$#2!9?!22w$#3!8?!15C$#5!31?w$#6!8?w-' +
    '#1!8~!12?!5w!7?!8~$#2!9?!11~!6B!5~$#3!25?w$#4!20?!6C$#5!31?~$#6!8?~-#1!8~!12?!5~!7?!8~$#2!9?!11~!6?!' +
    '5~$#3!25?~$#5!31?F$#6!8?~$#8!31?w-#1!8~!12?!5~!7?!8~$#2!9?!11~!6?!5~$#3!25?~$#6!8?~$#8!31?~-#1!8~!12' +
    '{!5~!7{!8~$#2!9?!11B!6?!5B$#3!25?B$#6!8?B$#8!31?B-#1@FF!34NFF@$#7EGG!34?G?E\x1b\\',
    github: '\x1bP9;1q"1;1;40;40#1;2;9;9;9#2;2;100;100;100#3;2;51;51;51#4;2;27;26;26#5;2;73;73;73#1!7?_oow!3{!4}!4~!' +
    '4}!3{woo_-#1??_w{}!3~BBFF!13N!3FBB!3~}{w_$#2!9?owwoo!12_oowwo$#3!14?O?OO!4?OO?O$#4!9?CC!4?O!8?O?G??C' +
    'C$#5!9?G??G!5?!4O!5?G??G-#1o}!5~NB!22?BN!5~}_$#2!8?o!21~|o$#3!7?_!24?_$#4!7?OC!22?CO$#5!8?G!21?AG-#1' +
    '!7~!25?_!7~$#2!8?!24~$#3!7?O!24?W$#4!7?_$#5!7?N!24?F-#1@N!3~!3N[woo__!11?!3_oow{!6~N@$#2!7?_?BFNN!3^' +
    '!8~^^!3NFB$#3!5?O!3?CG?O!14?O?GC$#4!5?_?OA!5?__!8?_!6?A$#5!6?o?`!17?O!4?@-#1!3?BFN^{o_`!4B!10?!8~^NF' +
    'B$#2!8?BM[!4W{!8~{$#3!9?@A?C??@!8?@$#4!7?AGO?!4_$#5!7?@C??C?CCA!8?A-#1!8?@BB!4F!10?!4FB@@$#2!15?@!8B' +
    '@\x1b\\',
    osv: '\x1bP9;1q"1;1;40;40#1;2;55;58;62#2;2;91;33;35#3;2;88;13;16#4;2;99;93;94#5;2;94;57;58#6;2;54;58;62#1!8?o' +
    '!3w{!5}!3~!6}{w{wo__$#6!7?_!3?C!4?@@!3?!3@!4?C!3?O-#1!3?_w{!4~^NNFB!3@!3?!5@BFF^^!3~}{o$#3!16?!8_$#6' +
    '!3?OCA!9?A??!3@!3?AA??G?_!3?@?G_-#1?c}!4~NB@!21?@N!5~w$#2!18?CGGCK$#3!11?_w{}!3~BFFBr!3~}{o$#4!19?OO' +
    'G$#5!18?w__o$#6?W@!4?o!23?A!6?E_-#1?^!5~g!25?!6~$#2!15?i?@!5?S$#3!11?N!3~@T!6?@@!3~^$#4!16?i}~~_~}i$' +
    '#5!15?S!4?^?@?}$#6?_!5?O!24?_!6?N-#1?@F!4~^K!20?_ow!5~N@$#2!17?@??A?@$#3!12?@BFMN!3][]]NMFB@$#4!18?!' +
    '4@$#5!15?@!8?@$#6??G!4?_Q!19?_?GE!5?OE-#1!5?@!3?_o{}!3{!8w{{}}!4~NNB@@$#6!4?@?@?_OG??AA?CC!5?C!3?@!4' +
    '?O?CA-#1!8?!4@!4B!9FBB!3@$#6!7?@!6?CC!4?GG!3?C?AA\x1b\\',
  },
  48: {
    npm: '\x1bP9;1q"1;1;48;48#1;2;80;22;22#2;2;100;100;100#3;2;85;41;41#4;2;95;82;82#5;2;90;61;61#6;2;79;22;21#7;' +
    '2;81;29;28#8;2;81;28;28#1w}!43~}}w$#6C!44?@?C-#1!10~!28N!10~$#2!11?!27_$#3!10?!28O$#4!10?_-#1!10~!28' +
    '?!10~$#2!11?!13~!7^!7~$#4!10?~$#5!24?!7_-#1!10~!15?!6~!7?!10~$#2!11?!13~!7?!7~$#4!10?~$#7!24?~-#1!10' +
    '~!15?!6~!7?!10~$#2!11?!13~!7?!7~$#4!10?~$#7!24?N$#8!24?o-#1!10~!15?!6~!7?!10~$#2!11?!13~!7?!7~$#4!10' +
    '?~$#8!24?~-#1!10~!14w{!6~!7w!10~$#2!11?!13B!7?!7B$#3!10?!14C!7?!7C$#4!10?B$#8!24?B-#1N^^!42~^^F$#6??' +
    '_!42?_?G\x1b\\',
    github: '\x1bP9;1q"1;1;48;48#1;2;27;26;26#2;2;100;100;100#3;2;9;9;9#4;2;67;67;67#5;2;45;44;44#6;2;86;86;86#3!9?_' +
    '_ooww{{!5}!4~!5}{{wwoo__-#1!13?O!20?O$#2!12?__!20?__$#3!4?ow{}!3~!3N^^!16~^^!3N!3~}{w_$#5!11?OO??_!1' +
    '6?_??OO$#6!11?_??_!18?_??_-#1!10?j!6?@?@!8?@!8?m$#2!11?!5~!16}!4~n$#3?o{!7~O!7?@!10?@!7?P!7~{o$#4!21' +
    '?!6@$#5!10?C!9?@!6?@??@$#6!16?@!14?@!4?O-#1!8?W!30?o$#2!9?w!27~}w$#3}!7~F@!28?@N!7~{$#4!9?A$#5!8?_!2' +
    '9?A$#6!9?C!27?@C-#1!8?B_!29?@$#2!9?F!28~F$#3^!7~{!29?_}!7~^$#4!38?G$#5!9?O!28?O$#6!9?G-#1!9?O!5?O!16' +
    '?O?G$#2!7?O__?@BFF!3N^^!8~^^!3NFFB@$#3?F^!3~n!3N]{woo!4_!10?!4_oow{}!7~^F$#4!6?O_O?@?C!4?O!10?_?O??G' +
    '?CA$#5!10?_??G??O!14?O!5?@$#6!11?A??G!4?_-#1!10?O`!5?C!11?@$#2!9?@F[W!5w{!10~$#3!3?@FN^~}w_?BB!3FB!1' +
    '2?!11~^NB@$#4!8?@!9?A!10?A$#5!9?C!3?C!4?@$#6!9?AGAc!16?{-#1!13?@$#2!18?FF!8NF$#3!8?@BBFFMM!3]!12?!3^' +
    'NNFFB@@$#5!14?!4@$#6!29?F\x1b\\',
    osv: '\x1bP9;1q"1;1;48;48#1;2;55;58;62#2;2;90;32;34#3;2;88;13;16#4;2;99;93;93#5;2;54;58;62#6;2;94;59;60#1!9?!' +
    '3_!3w{!4}!5~}}~!3}{{!3woo$#5!11?O??C!10?@@?@??A?CC!3?_-#1!4?_o{}!7~^N!3F!7B!3F!3N!6~}}wo_$#5!17?G??C' +
    '!11?O!6?@?CGO-#1??w{!6~^F@!22?@FN^!6~w$#2!22?_$#3!15?_ow{{}]]!3}]}{{wo_$#5!3?A!8?A@!21?A??_!6?C_$#6!' +
    '21?_!4?_-#1?}!7~!30?J!6~}O$#2!18?_OOK?@??GOO$#3!13?o!4~^NNA??@?ANN^!4~w$#4!19?__otyA~o_$#5?@!7?@!29?' +
    'S!6?@_$#6!21?@IC{?D?__-#1?V!7~_!29?}!7~B$#2!18?G`?_!4?_?KI$#3!13?@^!3~A?_!6?_`?!3~^F$#4!19?QI^~~o~^N' +
    'AC$#5?G!7?O!28?_@$#6!18?tKT!3?N??OOp-#1??@V^!3~^NM!24?ow}!6~^F@$#2!23?@@$#3!15?@BFF!3N^]]^^!3NFB@$#5' +
    '??AG_!3?_O!24?_-#1!5?BB@??__o{{}!3{!3woowooww{{!3}!5~^NFB$#5!11?OG?A?A!5?GG?GG!6?@!6?O??@-#1!9?!4BFF' +
    'NN^N!10^!3N!3FB@$#5!8?!5C!5?O!10?O??G!3?A@\x1b\\',
  },
}

// The largest of the logos that fits two of the terminal's cells, `cell` (its `width` and `height` in the
// pixels it draws sixel images in, as capabilities() tells them), and no taller than one; those 16 pixels
// square where none does, or `cell` isn't known.
export function logos(cell) {
  const fits = (size) => cell && size <= cell.height && size <= 2 * cell.width
  return LOGOS[Object.keys(LOGOS).map(Number).findLast(fits) ?? 16]
}

// Primary Device Attributes (DA1), which a terminal answers `CSI ? 62 ; 4 ; 22 c`, say: its class, then
// what it has, 4 being sixel graphics (tmux's `CSI ? 1 ; 2 ; 4 c` too). Every terminal answers it, so it is
// asked last, its answer telling the others have come, or won't.
const DA1 = '\x1b[c'
const SIXEL = '4'

// iTerm2's report of its cells' size, answered `OSC 1337 ; ReportCellSize=height;width;scale ST`: in points,
// `scale` the screen's pixels to a point, which it draws a sixel image's pixels as (two on a Retina screen).
const REPORT_CELL_SIZE = '\x1b]1337;ReportCellSize\x1b\\'
// A cell's size in pixels (XTWINOPS 16), answered `CSI 6 ; height ; width t`: as xterm.js draws sixel images,
// in CSS pixels; but iTerm2's in points, which it doesn't draw them in.
const CELL_SIZE = '\x1b[16t'

// The first reply in `read` that `pattern` matches after an ESC, its parameters; text like a reply,
// without its ESC, is not one.
const reply = (read, pattern) => [...read.matchAll(pattern)].find(({ index }) => read[index - 1] === '\x1b')

// Whether DA1's answer in `read` has sixel graphics among what the terminal has.
const sixelIn = (read) => reply(read, /\[\?([\d;]*)c/gu)?.[1].split(';').slice(1).includes(SIXEL) ?? false

// A cell's size in the pixels the terminal draws sixel images in: iTerm2's, its points by its scale; else
// XTWINOPS 16's; null where neither is answered.
function cellIn(read) {
  const iterm2 = reply(read, /\]1337;ReportCellSize=([\d.]+);([\d.]+)(?:;([\d.]+))?/gu)
  if (iterm2) return { height: iterm2[1] * (iterm2[3] ?? 1), width: iterm2[2] * (iterm2[3] ?? 1) }
  const xtwinops = reply(read, /\[6;(\d+);(\d+)t/gu)
  return xtwinops ? { height: Number(xtwinops[1]), width: Number(xtwinops[2]) } : null
}

// What the terminal `output` writes to answers `question` with, DA1 last, read on `input` up to DA1's answer;
// null where either is no terminal (a pipe, a file) or it is a dumb one (Emacs' shell), and nothing is asked,
// or it hasn't answered in `timeout` ms. Meanwhile `input` is raw, as a terminal answers there, and read, as
// it is left; a key pressed in that time is read with the answer and dropped.
function ask(question, { input = process.stdin, output = process.stdout, env = process.env, timeout = 1000 } = {}) {
  if (!input?.isTTY || !output?.isTTY || env.TERM === 'dumb') return Promise.resolve(null)
  const { promise, resolve } = Promise.withResolvers()
  const raw = input.isRaw
  const flowing = input.readableFlowing === true
  let read = ''
  const finish = (answer) => {
    clearTimeout(timer)
    input.off('data', onData)
    input.setRawMode(raw)
    if (!flowing) input.pause()
    resolve(answer)
  }
  // DA1's answer, `CSI ? Ps ; ... c`, may come in pieces, and after a key or another report.
  const onData = (chunk) => {
    read += chunk.toString('latin1')
    if (reply(read, /\[\?[\d;]*c/gu)) finish(read)
  }
  const timer = setTimeout(finish, timeout, null)
  input.setRawMode(true)
  input.on('data', onData)
  input.resume()
  output.write(question)
  return promise
}

// Whether the terminal `output` writes to draws sixel images: whether it answers DA1 with sixel graphics
// among what it has (see ask(), for `options`).
export const supported = async (options) => sixelIn((await ask(DA1, options)) ?? '')

// What the terminal `output` writes to tells of its images, in one round trip: whether it draws sixel images
// (`sixel`, as supported()), and its cells' size in the pixels it draws them in (`cell`, `{ width, height }`,
// see cellIn), null where it doesn't tell.
export async function capabilities(options) {
  const read = (await ask(REPORT_CELL_SIZE + CELL_SIZE + DA1, options)) ?? ''
  return { sixel: sixelIn(read), cell: cellIn(read) }
}
