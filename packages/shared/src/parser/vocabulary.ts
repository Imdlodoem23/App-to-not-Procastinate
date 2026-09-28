/**
 * Word lists for the parser, in folded form (lowercase, no accents, «ñ» → «n»). Each list
 * has a Spanish part and an English part: the parser reads both languages whatever the UI
 * locale, so «no veo YouTube en una hora» and «no YouTube for an hour» mean the same.
 * Apostrophes split words («don't» → «don» «t»), so contractions are listed by their parts.
 */

function words(...lists: string[]): ReadonlySet<string> {
  return new Set(lists.flatMap((list) => list.split(/\s+/)).filter((word) => word.length > 0));
}

/** Words that say «block this»: negations, imperatives and colloquial forms. */
export const TRIGGERS = words(
  `
  no ni nada sin nunca jamas tampoco cero fuera stop block
  bloquea bloqueame bloquear bloquearme bloqueo bloquee bloqueen bloqueas bloquealo bloqueala
  bloquealos bloquealas
  quita quitame quitar quitarme quitalo quitala quitalos quitalas quitate
  prohibido prohibida prohibidos prohibidas prohibe prohibeme prohibir prohibirme
  evita evitame evitar corta cortame cortar cierra cierrame cerrar apaga apagame apagar
  desactiva desactivame desactivar adios chao chau bye basta olvidate olvidarme
  bloquees
`,
  `
  block blocking blocked ban banned stop quit kill mute disable lock cut shut avoid without
  not never cannot dont wont cant off away goodbye enough zero neither nor pause close hide
  remove rid ditch forget
`,
);

/**
 * English contractions that say «block this» with the «t» after the apostrophe: «don't»,
 * «won't», «can't», «shouldn't», «mustn't».
 */
export const TRIGGERS_BEFORE_T = words('don won can shouldn mustn');

/**
 * Words allowed between a block word and a weak alias right after it: «no veo x», «no me
 * dejes entrar en reddit», «no quiero jugar», «sin el mine».
 */
export const TRIGGER_BRIDGE = words(
  `
  el la los las lo un una unos unas de del d a al en me te le les nos mi mis tu tus su sus
  ver veo veas vea mirar miro mires usar uso uses use entrar entro entres abrir abro abras
  meter meterme meto metas echar echo leer leo lees lea leas escuchar escucho escuches
  navegar navego navegues comprar compro compres jugar juego juegues juegue juegas jugando
  quiero quieres quiera quisiera kiero kieres puedo puedes pueda dejes deje dejeis dejen mas
`,
  `
  the a an my your of from on to into onto out off away me us t let lets allow want wanna need
  going gonna go get watch watching see seeing use using open opening play playing check
  checking browse browsing scroll scrolling visit visiting look looking at any more anymore be
  able
`,
);

/** Triggers only when followed by «de»: «paso de Instagram», «dejar de ver YouTube». */
export const TRIGGERS_BEFORE_DE = words('paso pasar deja dejar dejo');

/** «de», also in its texting spelling «d» («nada d redes»). */
export function isDe(word: string): boolean {
  return word === 'de' || word === 'd';
}

/** Words that add nothing on their own (articles, pronouns, filler verbs, politeness). */
export const SILENT = words(
  `
  el la los las lo un una unos unas de del d a al en por para pa pal con y e o u que q k
  me te se mi mis tu tus su sus nos le les yo
  ver veo veas vea mirar miro mires usar uso uses use entrar entro entres abrir abro abras
  meter meterme meto metas echar echo leo lees lea leas escuchar escucho escuches navegar
  navego navegues compro compres juegue juegues jugando jugar juego juegas comprar
  quiero quieres quiera quisiera kiero kieres voy vas va vamos ir
  tengo tienes tiene tenemos toca pongo poner ponerme ponga puedo puedes pueda poder
  necesito necesita ganas apetece falta permiteme dejeme dejes deje dejeis dejen dejame deja
  dejar dejo hacer hago haz estar estoy
  mas ya ahora hoy mismo porfa porfis porfi porfaa porfavor favor please pls plis plz xfa
  xfavor xfi xfis gracias vale ok okay
  oye venga eh bueno pues tio tia bro todo toda todos todas ningun ninguna ninguno ningunos
  ningunas algo esto este esta eso esa ese estos estas
  app apps aplicacion aplicaciones web webs pagina paginas online internet
  durante proximas proximos siguientes desde
  distracciones distraccion distraerme centrarme concentrarme centrar concentrar
  centrarse concentrarse enfocarme focus
`,
  `
  the a an to of for on in at from with by and or but so
  i im m me my myself you your u ur it its this that these those we us our he she they them
  him her his their
  please pls plz thanks thank thx ty ok okay hey hi yo well just really very
  now right today
  want wants wanted wanna need needs let lets lemme allow can could would will ll d s ve re t
  going gonna go get got keep stay be being is are am was do does doing did have has having
  watch watching see seeing use using open opening play playing check checking browse browsing
  scroll scrolling visit visiting look looking listen listening hop
  more anymore any some all every everything anything something stuff things thing
  apps sites site websites website page pages platforms platform account accounts
  distractions distraction distracted distracting focused focusing concentrate concentrating
  procrastinate procrastinating procrastination
  next during up out turn switch log take put starting
`,
);

/**
 * Silent words kept at the start of an unparsed fragment because they carry its meaning
 * («en clase», «durante la cena»).
 */
export const FRAGMENT_KEEP_START = words(
  'en por para pa con durante desde sobre este esta estos estas todo toda todos todas',
  'in at for on during with while from by this these all every everything after before but',
);

/** Laughter and similar noise («jajaja», «xd», «lol» when it is not League of Legends). */
const LAUGHTER_RE = /^(?:(?:j[aeijos])+j?|(?:ha){2,}h?|x+d+|lo+l|lmao)$/;

/** True for words that add nothing on their own: `SILENT` words and laughter. */
export function isFiller(word: string): boolean {
  return SILENT.has(word) || LAUGHTER_RE.test(word);
}

/** Words that want to use something («quiero ver YouTube»), not block it. */
export const DESIRE = words(
  'quiero quiera quisiera kiero voy vamos necesito puedo dejame apetece ganas',
  'want wants wanna need needs gonna going can could let lets lemme',
);
/**
 * Use verbs, infinitive and first person («ver», «veo», «jugar», «juego»…). Without a block
 * word, one of them before a target means the user wants to use it: «ver Netflix 2h».
 */
export const CONSUME = words(
  `
  ver veo mirar miro jugar juego usar uso entrar entro abrir abro abre abreme echar echo
  meterme meto leo escuchar escucho comprar compro navegar navego chatear
`,
  `
  watch watching see seeing play playing use using open opening check checking browse browsing
  scroll scrolling visit visiting look looking listen listening go get hop text chatting
`,
);
/** Words that want a target right after them: «necesito el WhatsApp», «ganas de YouTube». */
export const DESIRE_BEFORE_TARGET = words(
  `
  necesito necesita necesitamos apetece ganas falta dejame dejeme permiteme
`,
  'need needs allow',
);

/** Study verbs dropped from the task: «estudiar mates» → task «mates». */
export const STUDY_VERBS = words(
  `
  estudiar estudio estudia estudiando estudiare estudie estudiemos
  repasar repaso repasa repasando repasare repase
`,
  `
  study studying revise revising review reviewing cram cramming practice practicing practise
  practising
`,
);

/** Study nouns kept in the task: «hacer deberes de inglés» → task «deberes de inglés». */
export const STUDY_NOUNS = words(
  'deberes tarea tareas leer lectura',
  'homework assignment assignments coursework reading',
);

/**
 * Study nouns that count only after «hacer»: «hacer el trabajo de historia», «hacer
 * ejercicios de mates». Alone they are ordinary words («voy al trabajo»).
 */
export const STUDY_NOUNS_AFTER_HACER = words(
  `
  trabajo trabajos ejercicio ejercicios apuntes resumen resumenes esquema esquemas
  actividades redaccion
`,
  `
  essay essays project projects exercise exercises worksheet worksheets notes summary report
  paper problems
`,
);

/**
 * English study nouns that take the words before them into the task: «math homework» →
 * task «math homework», «do my history essay» → «history essay».
 */
export const STUDY_COMPOUND_NOUNS = words(`
  homework assignment assignments coursework essay essays project projects worksheet
  worksheets notes summary report paper problems exercises
`);

/** Verbs that may introduce a study noun («hacer los deberes», «do my homework»). */
export const STUDY_NOUN_VERBS = words(
  'hacer hago haz hacemos haciendo',
  'do doing finish finishing write writing work working',
);
export const STUDY_NOUN_ARTICLES = words(
  'el la los las mi mis un una unos unas',
  'my the a an some this that your on',
);

/** Filler and time words never kept at either end of a task: «estudiar ya», «un rato». */
const TASK_FILLER = `
  ya ahora hoy rato ratito seguidas seguidos seguida seguido toda todo todas todos tarde noche
  mas menos poco bien entera entero asi
  now today tonight right straight bit little while more less please pls just all whole entire
  morning afternoon evening night day
`;

/** Leading words removed from a task: «estudiar para el examen» → «examen». */
export const TASK_TRIM_START = words(
  `
  de del d el la los las lo un una unos unas para pa sobre a al un poco algo mi mis
  ${TASK_FILLER}
`,
  'for the a an my some on about to of in with',
);

/** Trailing words removed from a task. */
export const TASK_TRIM_END = words(
  `
  y e o u ni de del d el la los las un una a al para pa por en con durante que me esta este
  ${TASK_FILLER}
`,
  'and or nor but for the a an to in on at of with until till during that my then',
);

/**
 * Other known words, never fuzzy-matched to a service («diario» must not become the
 * news category «diarios»).
 */
export const OTHER_KNOWN = words(
  `
  hasta asta manana tarde noche madrugada mediodia medianoche media medio cuarto cuartos
  punto menos hora horas horita horitas ora oras minuto minutos minutito minutitos dia dias
  semana semanas ayer luego despues antes rato ratito diario diaria clase clases movil tele
  ordenador examen examenes trabajo modo estricto hardcore normal cenar comer dormir
  insti instituto cole colegio tienda tiendecita compra super supermercado momento vida
  disco discos valorar valora valoro steams sports amazonas maximo entera entero seguidas
  seguidos excepto salvo quitando exceptuando pero cuando aqui aki sean
`,
  `
  until till til untill before after then later soon afterwards tonight tomorrow tmrw tmr
  tomorow tommorow tommorrow morning afternoon evening night noon midday midnight half quarter
  quarters past couple few while time end rest o clock oclock
  class classes school exam exams test tests work job home dinner lunch breakfast sleep bed
  bedtime phone computer laptop mode strict hardcore normal except excluding besides apart
  other than when here there maximum minimum tops total row least most around about approx
  roughly like only twice streaks
`,
);
