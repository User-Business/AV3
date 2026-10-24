import { StatusLote, StatusRastreamento } from '../generated/prisma/enums.js';
import { STATUS_PRE_TRIAGEM } from './equipamento.js';
import { ErroRegraNegocio, ErroValidacao } from './erros.js';

export const JANELA_RETROATIVA_DIAS = 90;
/** Tolerância para relógios levemente adiantados no cliente. */
const TOLERANCIA_FUTURO_MS = 5 * 60 * 1000;
const UM_DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Regra herdada do CLI: não aceitar data de entrada futura nem anterior a mais
 * de noventa dias.
 */
export function validarDataEntrada(dataEntrada: Date, agora = new Date()): void {
  if (Number.isNaN(dataEntrada.getTime())) {
    throw new ErroValidacao('dataEntrada inválida');
  }
  if (dataEntrada.getTime() > agora.getTime() + TOLERANCIA_FUTURO_MS) {
    throw new ErroValidacao('dataEntrada não pode estar no futuro');
  }
  if (dataEntrada.getTime() < agora.getTime() - JANELA_RETROATIVA_DIAS * UM_DIA_MS) {
    throw new ErroValidacao(`dataEntrada não pode ser anterior a ${JANELA_RETROATIVA_DIAS} dias`);
  }
}

export const TRANSICOES_LOTE: Readonly<Record<StatusLote, readonly StatusLote[]>> = {
  RECEBIDO: [StatusLote.EM_TRIAGEM],
  EM_TRIAGEM: [StatusLote.TRIAGEM_CONCLUIDA],
  TRIAGEM_CONCLUIDA: [StatusLote.ENCAMINHADO],
  ENCAMINHADO: [StatusLote.FINALIZADO],
  FINALIZADO: [],
};

export interface DadosLote {
  id: string;
  organizacaoId: string;
  statusProcessamento: StatusLote;
  versao: number;
}

export class Lote {
  private constructor(
    private readonly dados: DadosLote,
    private readonly statusEquipamentos: readonly StatusRastreamento[],
    private readonly pesosEquipamentos: readonly number[] = [],
  ) {}

  static restaurar(
    dados: DadosLote,
    equipamentos: readonly { statusRastreamento: StatusRastreamento; pesoQuilogramas: number }[],
  ): Lote {
    return new Lote(
      { ...dados },
      equipamentos.map((e) => e.statusRastreamento),
      equipamentos.map((e) => e.pesoQuilogramas),
    );
  }

  get id() { return this.dados.id; }
  get status() { return this.dados.statusProcessamento; }
  get versao() { return this.dados.versao; }

  /** Inclusão/remoção de equipamentos só enquanto o lote não entrou em triagem. */
  garantirAbertoParaAlteracao(): void {
    if (this.dados.statusProcessamento !== StatusLote.RECEBIDO) {
      throw new ErroRegraNegocio(
        `Equipamentos só podem ser incluídos/removidos com o lote RECEBIDO (atual: ${this.dados.statusProcessamento})`,
      );
    }
  }

  garantirPodeRemoverEquipamento(): void {
    this.garantirAbertoParaAlteracao();
    // Multiplicidade 1..* do diagrama: o lote nunca fica vazio
    if (this.statusEquipamentos.length <= 1) {
      throw new ErroRegraNegocio('Um lote deve conter ao menos um equipamento');
    }
  }

  avancarStatus(novo: StatusLote): { origem: StatusLote; destino: StatusLote } {
    const atual = this.dados.statusProcessamento;
    if (!TRANSICOES_LOTE[atual].includes(novo)) {
      throw new ErroRegraNegocio(`Transição de lote inválida: ${atual} -> ${novo}`, {
        permitidas: TRANSICOES_LOTE[atual],
      });
    }

    if (novo === StatusLote.TRIAGEM_CONCLUIDA) {
      const pendentes = this.statusEquipamentos.filter((s) => STATUS_PRE_TRIAGEM.includes(s)).length;
      if (pendentes > 0) {
        throw new ErroRegraNegocio(`Ainda há ${pendentes} equipamento(s) sem classificação de triagem`);
      }
    }

    if (novo === StatusLote.FINALIZADO) {
      const abertos = this.statusEquipamentos.filter((s) => s !== StatusRastreamento.BAIXA_DEFINITIVA).length;
      if (abertos > 0) {
        throw new ErroRegraNegocio(`Ainda há ${abertos} equipamento(s) sem baixa definitiva`);
      }
    }

    this.dados.statusProcessamento = novo;
    return { origem: atual, destino: novo };
  }

  calcularPesoTotal(): number {
    const total = this.pesosEquipamentos.reduce((soma, p) => soma + p, 0);
    return Math.round(total * 1000) / 1000;
  }
}
